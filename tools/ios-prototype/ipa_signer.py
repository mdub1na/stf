"""Private signing endpoint for a single provisioned iPhone app."""

import argparse
import datetime
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

from ipa_metadata import InvalidIpa, inspect


CHUNK_SIZE = 1024 * 1024
MAX_BYTES = 1024 ** 3
READ_TIMEOUT = 20
UPLOAD_TIMEOUT = 120
SIGN_TIMEOUT = 120
UDID = re.compile(r"(?:[0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{40})", re.I)
BUNDLE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,254}")
SHA256 = re.compile(r"[0-9a-f]{64}")
IDENTITY_SHA1 = re.compile(r"[0-9a-f]{40}", re.I)


class SignerError(Exception):
  def __init__(self, code, status=400):
    super().__init__(code)
    self.status = status


def require(condition, code, status=400):
  if not condition:
    raise SignerError(code, status)


def openssl(args, **kwargs):
  return subprocess.run(["openssl", *args], stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL, timeout=10, check=True, **kwargs).stdout


def read_file(filename, size):
  path = Path(filename)
  require(path.is_absolute() and path.is_file(), "IOS_IPA_SIGNING_PROFILE_INVALID", 500)
  with path.open("rb") as stream:
    value = stream.read(size + 1)
  require(0 < len(value) <= size, "IOS_IPA_SIGNING_PROFILE_INVALID", 500)
  return value


def permitted(value, allowed):
  if type(value) is not type(allowed):
    return False
  if isinstance(value, dict):
    return all(key in allowed and permitted(item, allowed[key]) for key, item in value.items())
  if isinstance(value, list):
    return all(any(permitted(item, choice) for choice in allowed) for item in value)
  if isinstance(value, str) and allowed.endswith("*") and "*" not in allowed[:-1]:
    return "*" not in value and value.startswith(allowed[:-1])
  return value == allowed


class Policy:
  def __init__(self, filename, use_keychain=False):
    code = "IOS_IPA_SIGNING_PROFILE_INVALID"
    try:
      value = json.loads(read_file(filename, 64 * 1024))
      require(isinstance(value, dict), code, 500)
      self.rebind_bundle_id = "rebindBundleId" in value
      if self.rebind_bundle_id:
        require(use_keychain and value["rebindBundleId"] is True, code, 500)
      fields = {"bundleId", "deviceUdids", "profilePath", "entitlementsPath"}
      fields.add("rebindBundleId" if self.rebind_bundle_id else "allowedIpaSha256")
      fields |= {"identitySha1"} if use_keychain else {"certificatePath", "privateKeyPath"}
      require(set(value) == fields, code, 500)
      self.bundle_id = value["bundleId"]
      require(isinstance(self.bundle_id, str) and BUNDLE_ID.fullmatch(self.bundle_id), code, 500)
      devices = value["deviceUdids"]
      require(isinstance(devices, list) and devices and all(
          isinstance(item, str) and UDID.fullmatch(item) for item in devices), code, 500)
      self.devices = frozenset(item.lower() for item in devices)
      self.allowed_ipa_sha256 = None
      if not self.rebind_bundle_id:
        digests = value["allowedIpaSha256"]
        require(isinstance(digests, list) and digests and all(
            isinstance(item, str) and SHA256.fullmatch(item) for item in digests), code, 500)
        self.allowed_ipa_sha256 = frozenset(digests)

      self.profile_bytes = read_file(value["profilePath"], 4 * CHUNK_SIZE)
      self.entitlements = read_file(value["entitlementsPath"], 64 * 1024)
      profile = plistlib.loads(openssl(
          ["cms", "-verify", "-inform", "DER", "-noverify"], input=self.profile_bytes))
      require("iOS" in profile.get("Platform", []), code, 500)
      require(self.devices <= {item.lower() for item in profile["ProvisionedDevices"]}, code, 500)
      self.expires = profile["ExpirationDate"]
      require(isinstance(self.expires, datetime.datetime), code, 500)
      if self.expires.tzinfo is None:
        self.expires = self.expires.replace(tzinfo=datetime.timezone.utc)

      entitlements = plistlib.loads(self.entitlements)
      grants = profile["Entitlements"]
      team, = profile["TeamIdentifier"]
      identifier = grants["application-identifier"]
      require(isinstance(grants, dict) and isinstance(entitlements, dict)
          and bool(team) and identifier.partition(".")[2] == self.bundle_id
          and entitlements["application-identifier"] == identifier
          and entitlements["com.apple.developer.team-identifier"] == team
          and permitted(entitlements, grants), code, 500)
      if self.rebind_bundle_id:
        # Different uploads share the slot identity. Grant only the slot's private Keychain group.
        require(entitlements.keys() <= {"application-identifier", "com.apple.developer.team-identifier",
            "get-task-allow", "keychain-access-groups"}
            and all(group == identifier for group in entitlements.get("keychain-access-groups", [])),
            code, 500)
      self.entitlements = plistlib.dumps(entitlements)
      self.check_validity()

      self.identity_sha1 = None
      certificates = profile["DeveloperCertificates"]
      if use_keychain:
        identity = value["identitySha1"]
        require(isinstance(identity, str) and IDENTITY_SHA1.fullmatch(identity), code, 500)
        identity = identity.upper()
        cert = next((data for data in certificates if hashlib.sha1(data).hexdigest().upper() == identity),
            None)
        require(cert is not None, code, 500)
        openssl(["x509", "-inform", "DER", "-checkend", "0", "-noout"], input=cert)
        available = subprocess.run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
        identities = re.findall(rb"^\s*\d+\)\s+([0-9A-Fa-f]{40})\s", available, re.M)
        require(identity.encode("ascii") in {item.upper() for item in identities}, code, 500)
        self.identity_sha1 = identity
      else:
        self.cert = read_file(value["certificatePath"], 64 * 1024)
        self.key = read_file(value["privateKeyPath"], 64 * 1024)
        cert = openssl(["x509", "-outform", "DER"], input=self.cert)
        openssl(["x509", "-checkend", "0", "-noout"], input=self.cert)
        public_key = openssl(["pkey", "-pubout", "-passin", "pass:"], input=self.key)
        require(public_key == openssl(["x509", "-pubkey", "-noout"], input=self.cert)
            and cert in certificates, code, 500)
    except (KeyError, ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
      raise SignerError(code, 500) from None

  def check_validity(self):
    require(self.expires > datetime.datetime.now(datetime.timezone.utc),
        "IOS_IPA_SIGNING_PROFILE_INVALID", 422)

  def check_device(self, udid):
    require(udid.lower() in self.devices, "IOS_IPA_SIGNING_NOT_ALLOWED", 403)
    self.check_validity()


def inspect_app(path, udid, version):
  try:
    return inspect(str(path), udid, version, allow_unsigned=True)
  except InvalidIpa as error:
    if re.fullmatch(r"IOS_IPA_[A-Z_]+", str(error)):
      raise SignerError(str(error), 422) from None
    raise SignerError("IOS_IPA_SIGNING_INVALID_REQUEST", 422) from None
  except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, subprocess.SubprocessError):
    raise SignerError("IOS_IPA_SIGNING_INVALID_REQUEST", 422) from None


def sign_with_zsign(zsign, policy, source, output, private, scratch):
  for name, contents in (("identity.pem", policy.key), ("identity.crt", policy.cert),
      ("profile.mobileprovision", policy.profile_bytes), ("entitlements.plist", policy.entitlements)):
    descriptor = os.open(private / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as file:
      file.write(contents)
  subprocess.run([zsign, "-f", "-q", "-k", str(private / "identity.pem"),
      "-c", str(private / "identity.crt"), "-m", str(private / "profile.mobileprovision"),
      "-e", str(private / "entitlements.plist"), "-t", str(scratch),
      "-o", str(output), str(source)], cwd=scratch, stdin=subprocess.DEVNULL,
      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=SIGN_TIMEOUT, check=True)


def sign_with_keychain(policy, source, output, private, scratch):
  # Extract only the device app already checked by the unsigned archive preflight.
  with zipfile.ZipFile(source) as archive:
    info = next(entry for entry in archive.infolist()
        if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", entry.filename))
    root = info.filename.removesuffix("Info.plist")
    for entry in archive.infolist():
      if entry.filename.startswith(root) and not entry.is_dir():
        path = scratch / entry.filename
        path.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(entry) as data, path.open("xb") as target:
          shutil.copyfileobj(data, target, CHUNK_SIZE)
        path.chmod(0o755 if entry.external_attr >> 16 & 0o111 else 0o644)
  app = scratch / root
  info_path = app / "Info.plist"
  info_data = info_path.read_bytes()
  info = plistlib.loads(info_data)
  if policy.rebind_bundle_id and info["CFBundleIdentifier"] != policy.bundle_id:
    info["CFBundleIdentifier"] = policy.bundle_id
    plist_format = plistlib.FMT_BINARY if info_data.startswith(b"bplist00") else plistlib.FMT_XML
    info_path.write_bytes(plistlib.dumps(info, fmt=plist_format, sort_keys=False))
  (app / info["CFBundleExecutable"]).chmod(0o755)
  (app / "embedded.mobileprovision").write_bytes(policy.profile_bytes)
  entitlements = private / "entitlements.plist"
  entitlements.write_bytes(policy.entitlements)

  deadline = time.monotonic() + SIGN_TIMEOUT

  def codesign(*arguments):
    timeout = deadline - time.monotonic()
    require(timeout > 0, "IOS_IPA_SIGNING_FAILED", 502)
    subprocess.run(["/usr/bin/codesign", *arguments], cwd=scratch, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=True)

  flags = ("--force", "--sign", policy.identity_sha1, "--timestamp=none", "--generate-entitlement-der")
  libraries = [path for path in (app / "Frameworks").rglob("*")
      if (path.is_dir() and path.suffix == ".framework") or (path.is_file() and path.suffix == ".dylib")]
  for path in sorted(libraries, key=lambda path: (-len(path.parts), path)):
    codesign(*flags, str(path))
  codesign(*flags, "--entitlements", str(entitlements), str(app))
  codesign("--verify", "--deep", "--strict", str(app))

  with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
    for path in sorted(app.rglob("*")):
      if path.is_file():
        archive.write(path, path.relative_to(scratch).as_posix())
        require(output.stat().st_size <= MAX_BYTES, "IOS_IPA_SIGNING_FAILED", 502)


def sign(zsign, policy, source, output, udid, version):
  original = inspect_app(source, udid, version)
  code = "IOS_IPA_SIGNING_NOT_ALLOWED"
  require(original.get("signature") == "unsigned"
      and (policy.rebind_bundle_id or original["package"] == policy.bundle_id), code, 403)
  policy.check_device(udid)
  with tempfile.TemporaryDirectory(dir=source.parent) as directory:
    private = Path(directory)
    scratch = private / "scratch"
    scratch.mkdir(mode=0o700)
    if policy.identity_sha1:
      try:
        sign_with_keychain(policy, source, output, private, scratch)
      except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, subprocess.SubprocessError):
        raise SignerError("IOS_IPA_SIGNING_FAILED", 502) from None
    else:
      sign_with_zsign(zsign, policy, source, output, private, scratch)

  try:
    info = output.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_BYTES, "IOS_IPA_SIGNING_FAILED", 502)
    signed = inspect_app(output, udid, version)
    require(signed.get("signature") == "signed" and signed["package"] == policy.bundle_id
        and all(signed[key] == original[key] for key in ("version", "minimumOSVersion")),
        "IOS_IPA_SIGNING_FAILED", 502)
    with zipfile.ZipFile(output) as archive:
      roots = [name.removesuffix("Info.plist") for name in archive.namelist()
          if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
      require(len(roots) == 1 and archive.read(roots[0] + "embedded.mobileprovision") == policy.profile_bytes,
          "IOS_IPA_SIGNING_FAILED", 502)
  except (OSError, KeyError, zipfile.BadZipFile, SignerError):
    raise SignerError("IOS_IPA_SIGNING_FAILED", 502) from None


class SignerServer(HTTPServer):
  def __init__(self, address, zsign, policy, token, tls=None):
    self.zsign = zsign
    self.policy = policy
    self.token = token
    self.tls = tls
    super().__init__(address, Handler)

  def get_request(self):
    sock, address = super().get_request()
    # Bound both the TLS handshake and subsequent individual socket reads.
    sock.settimeout(READ_TIMEOUT)
    if self.tls:
      try:
        sock = self.tls.wrap_socket(sock, server_side=True)
      except OSError:
        sock.close()
        raise
    return sock, address


class Handler(BaseHTTPRequestHandler):
  def log_message(self, *_args):
    pass

  def header(self, name):
    values = self.headers.get_all(name, [])
    require(len(values) == 1, "IOS_IPA_SIGNING_INVALID_REQUEST")
    return values[0]

  def request_info(self):
    code = "IOS_IPA_SIGNING_INVALID_REQUEST"
    if self.path != "/sign":
      raise SignerError(code, 404)
    authorization = self.headers.get_all("Authorization", [])
    require(len(authorization) == 1 and hmac.compare_digest(
        authorization[0].encode("utf-8"), b"Bearer " + self.server.token),
        "IOS_IPA_SIGNING_UNAUTHORIZED", 401)
    require(self.header("Content-Type") == "application/octet-stream"
        and not self.headers.get_all("Transfer-Encoding"), code)
    length = self.header("Content-Length")
    require(re.fullmatch(r"[1-9][0-9]{0,9}", length) and int(length) <= MAX_BYTES, code, 413)
    udid, version, digest = (self.header("X-STF-IPA-" + field)
        for field in ("UDID", "IOS-Version", "SHA256"))
    require(UDID.fullmatch(udid) and re.fullmatch(r"[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}", version)
        and SHA256.fullmatch(digest), code)
    self.server.policy.check_device(udid)
    allowed = self.server.policy.allowed_ipa_sha256
    require(allowed is None or digest in allowed, "IOS_IPA_SIGNING_NOT_ALLOWED", 403)
    return int(length), udid, version, digest

  def receive(self, path, length, digest):
    deadline = time.monotonic() + UPLOAD_TIMEOUT
    sha = hashlib.sha256()
    with path.open("xb") as file:
      while length:
        require(time.monotonic() < deadline, "IOS_IPA_SIGNING_INVALID_REQUEST", 408)
        data = self.rfile.read1(min(CHUNK_SIZE, length))
        require(data, "IOS_IPA_SIGNING_INVALID_REQUEST")
        file.write(data)
        sha.update(data)
        length -= len(data)
    require(hmac.compare_digest(sha.hexdigest(), digest), "IOS_IPA_SIGNING_INVALID_REQUEST")

  def headers_from(self, status, content_type, length, digest=None):
    self.send_response(status)
    self.send_header("Content-Type", content_type)
    self.send_header("Content-Length", str(length))
    self.send_header("Cache-Control", "no-store")
    self.send_header("Connection", "close")
    if digest is not None:
      self.send_header("X-STF-IPA-SHA256", digest)
    self.end_headers()

  def do_POST(self):
    with tempfile.TemporaryDirectory(prefix="stf-ipa-sign-") as directory:
      source = Path(directory) / "input.ipa"
      output = Path(directory) / "signed.ipa"
      try:
        length, udid, version, digest = self.request_info()
        self.receive(source, length, digest)
        sign(self.server.zsign, self.server.policy, source, output, udid, version)
        with output.open("rb") as file:
          sha = hashlib.sha256()
          while data := file.read(CHUNK_SIZE):
            sha.update(data)
          length = file.tell()
      except SignerError as error:
        self.error(error)
        return
      except TimeoutError:
        self.error(SignerError("IOS_IPA_SIGNING_INVALID_REQUEST", 408))
        return
      except (OSError, subprocess.SubprocessError):
        self.error(SignerError("IOS_IPA_SIGNING_FAILED", 502))
        return

      try:
        with output.open("rb") as file:
          self.headers_from(200, "application/octet-stream", length, sha.hexdigest())
          deadline = time.monotonic() + UPLOAD_TIMEOUT
          while time.monotonic() < deadline and (data := file.read(CHUNK_SIZE)):
            self.wfile.write(data)
      except OSError:
        pass

  def error(self, error):
    try:
      body = json.dumps({"error": str(error)}).encode()
      self.headers_from(error.status, "application/json", len(body))
      self.wfile.write(body)
    except OSError:
      pass


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--policy-file", required=True)
  parser.add_argument("--token-file", required=True)
  backend = parser.add_mutually_exclusive_group(required=True)
  backend.add_argument("--zsign", help="Absolute path to the trusted zsign executable")
  backend.add_argument("--codesign", action="store_true", help="Use macOS codesign with a Keychain identity")
  parser.add_argument("--bind", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=7443)
  parser.add_argument("--tls-cert")
  parser.add_argument("--tls-key")
  args = parser.parse_args()
  if bool(args.tls_cert) != bool(args.tls_key) or (args.bind != "127.0.0.1" and not args.tls_cert):
    parser.error("TLS certificate and key are required outside IPv4 loopback")
  if args.zsign and (not Path(args.zsign).is_absolute() or not Path(args.zsign).is_file()):
    parser.error("An absolute path to a trusted zsign binary is required")
  if args.codesign and sys.platform != "darwin":
    parser.error("--codesign requires macOS")
  try:
    os.umask(0o077)
    token = read_file(args.token_file, 258).strip()
    require(re.fullmatch(rb"[A-Za-z0-9_-]{32,256}", token), "IOS_IPA_SIGNING_UNAUTHORIZED", 500)
    policy = Policy(args.policy_file, use_keychain=args.codesign)
    tls = None
    if args.tls_cert:
      tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
      tls.minimum_version = ssl.TLSVersion.TLSv1_2
      tls.load_cert_chain(args.tls_cert, args.tls_key)
    with SignerServer((args.bind, args.port), args.zsign, policy, token, tls) as server:
      server.serve_forever()
  except (SignerError, OSError) as error:
    parser.error(str(error) if isinstance(error, SignerError) else "Could not start signing worker")
  except KeyboardInterrupt:
    pass


if __name__ == "__main__":
  main()

"""Exercise the signer HTTP boundary with synthetic IPA and a stand-in signer."""

import datetime
import hashlib
from http.client import HTTPConnection
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1]))
from ipa_signer import Policy, sign, SignerError, SignerServer

TOKEN = b"a" * 32
BUNDLE = "test.stf.app"
UDID = "00008110-001454941A46801E"
OTHER_UDID = "00008110-001454941A46801F"
TEAM = "TEAM123456"
ENTITLEMENTS = {
    "application-identifier": TEAM + "." + BUNDLE,
    "com.apple.developer.team-identifier": TEAM,
    "keychain-access-groups": [TEAM + "." + BUNDLE],
}


def binary(signed):
  commands = struct.pack("<IIIIII", 0x32, 24, 2, 0x120000, 0x1b0000, 0)
  blob = b""
  if signed:
    directory = struct.pack(">IIII", 0xfade0c02, 44, 0x20001, 0).ljust(44, b"\0")
    cms = struct.pack(">II", 0xfade0b01, 9) + b"x"
    blob = struct.pack(">IIIIIII", 0xfade0cc0, 28 + len(directory) + len(cms), 2,
        0, 28, 0x10000, 28 + len(directory)) + directory + cms
    commands += struct.pack("<IIII", 0x1d, 16, 32 + len(commands) + 16, len(blob))
  return struct.pack("<IIIIIIII", 0xfeedfacf, 0x0100000c, 0, 2, 2 if signed else 1,
      len(commands), 0, 0) + commands + blob


def app(path, profile=None, bundle=BUNDLE, version="1.0", plist_format=plistlib.FMT_XML):
  with zipfile.ZipFile(path, "w") as archive:
    root = "Payload/Test.app/"
    archive.writestr(root + "Info.plist", plistlib.dumps({
      "CFBundleIdentifier": bundle, "CFBundleExecutable": "Test", "CFBundlePackageType": "APPL",
      "CFBundleSupportedPlatforms": ["iPhoneOS"], "MinimumOSVersion": "18.0",
      "CFBundleShortVersionString": version,
    }, fmt=plist_format))
    archive.writestr(root + "Test", binary(profile is not None))
    if profile is not None:
      archive.writestr(root + "_CodeSignature/CodeResources", b"fixture")
      archive.writestr(root + "embedded.mobileprovision", profile)


def run(command, **kwargs):
  return subprocess.run(command, **kwargs, capture_output=True, check=True).stdout


def request(server, payload, **overrides):
  client = HTTPConnection("127.0.0.1", server.server_port, timeout=15)
  headers = {
    "Authorization": "Bearer " + TOKEN.decode(),
    "Content-Type": "application/octet-stream",
    "Content-Length": str(len(payload)),
    "X-STF-IPA-UDID": UDID,
    "X-STF-IPA-IOS-Version": "27.0.1",
    "X-STF-IPA-SHA256": hashlib.sha256(payload).hexdigest(),
    **overrides,
  }
  try:
    client.request("POST", "/sign", payload, headers)
    response = client.getresponse()
    return response.status, response.headers, response.read()
  finally:
    client.close()


with tempfile.TemporaryDirectory(prefix="stf-ipa-signer-test-") as tmp:
  root = Path(tmp)
  key, certificate = root / "identity.pem", root / "identity.crt"
  run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=STF signer fixture", "-keyout", str(key), "-out", str(certificate)])
  der = run(["openssl", "x509", "-outform", "DER", "-in", str(certificate)])
  expires = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(hours=2)
  profile = {
    "ExpirationDate": expires, "Platform": ["iOS"], "TeamIdentifier": [TEAM],
    "ProvisionedDevices": [UDID, OTHER_UDID], "DeveloperCertificates": [der],
    "Entitlements": {**ENTITLEMENTS, "keychain-access-groups": [TEAM + ".*"]},
  }
  prof = run(["openssl", "cms", "-sign", "-binary", "-nodetach", "-outform", "DER",
      "-signer", str(certificate), "-inkey", str(key)], input=plistlib.dumps(profile))
  source, signed, other = root / "source.ipa", root / "signed.ipa", root / "other.ipa"
  calls = root / "calls"
  app(source)
  app(signed, prof)
  app(other, bundle="test.stf.other")
  signed_digest = hashlib.sha256(signed.read_bytes()).hexdigest()
  expected = {
    "bundleId": BUNDLE, "deviceUdids": [UDID], "profilePath": str(root / "fixture.mobileprovision"),
    "allowedIpaSha256": [hashlib.sha256(source.read_bytes()).hexdigest(), signed_digest,
        hashlib.sha256(other.read_bytes()).hexdigest()],
    "privateKeyPath": str(key), "certificatePath": str(certificate),
    "entitlementsPath": str(root / "entitlements.plist"),
  }
  (root / "fixture.mobileprovision").write_bytes(prof)
  (root / "entitlements.plist").write_bytes(plistlib.dumps(ENTITLEMENTS))
  policy_file = root / "policy.json"
  policy_file.write_text(json.dumps(expected))
  policy = Policy(policy_file)
  (root / "entitlements.plist").write_bytes(plistlib.dumps({**ENTITLEMENTS, "get-task-allow": True}))
  try:
    Policy(policy_file)
    raise AssertionError("unprovisioned entitlements were accepted")
  except SignerError as error:
    assert str(error) == "IOS_IPA_SIGNING_PROFILE_INVALID", error

  # Keychain selection must pin a certificate from the profile without opening a PEM key.
  (root / "entitlements.plist").write_bytes(plistlib.dumps(ENTITLEMENTS))
  keychain_policy_file = root / "keychain-policy.json"
  keychain_values = {
    name: value for name, value in expected.items() if name not in {"privateKeyPath", "certificatePath"}
  }
  identity = hashlib.sha1(der).hexdigest()
  real_run = subprocess.run
  codesign_calls = []

  def keychain_tools(command, **kwargs):
    if command[0] == "/usr/bin/security":
      assert command[1:] == ["find-identity", "-v", "-p", "codesigning"]
      return subprocess.CompletedProcess(command, 0, f'  1) {identity.upper()} "Fixture"\n'.encode())
    if command[0] != "/usr/bin/codesign":
      return real_run(command, **kwargs)
    codesign_calls.append(command)
    bundle_path = Path(command[-1])
    if command[1] == "--verify":
      assert command[1:-1] == ["--verify", "--deep", "--strict"]
      assert (bundle_path / "_CodeSignature/CodeResources").is_file()
    else:
      assert command[1:6] == ["--force", "--sign", identity.upper(),
          "--timestamp=none", "--generate-entitlement-der"]
      if bundle_path.name == "Test.app":
        assert command[6] == "--entitlements"
        assert plistlib.loads(Path(command[7]).read_bytes()) == ENTITLEMENTS
        assert (bundle_path / "embedded.mobileprovision").read_bytes() == prof
        assert plistlib.loads((bundle_path / "Info.plist").read_bytes())["CFBundleIdentifier"] == BUNDLE
        assert (bundle_path / "Test").stat().st_mode & 0o111
        (bundle_path / "Test").write_bytes(binary(True))
        (bundle_path / "_CodeSignature").mkdir()
        (bundle_path / "_CodeSignature/CodeResources").write_bytes(b"fixture")
      else:
        assert len(command) == 7
    return subprocess.CompletedProcess(command, 0)

  def bad_keychain_policy(use_keychain=True):
    try:
      Policy(keychain_policy_file, use_keychain=use_keychain)
      raise AssertionError("An unauthorized Keychain identity was accepted")
    except SignerError as error:
      assert str(error) == "IOS_IPA_SIGNING_PROFILE_INVALID", error

  with patch("ipa_signer.subprocess.run", side_effect=keychain_tools):
    keychain_policy_file.write_text(json.dumps({**keychain_values, "identitySha1": "0" * 40}))
    bad_keychain_policy()
    keychain_policy_file.write_text(json.dumps({**keychain_values, "identitySha1": identity}))
    keychain = Policy(keychain_policy_file, use_keychain=True)
    assert keychain.identity_sha1 == identity.upper() and not hasattr(keychain, "key")
    keychain_input = root / "keychain-input.ipa"
    keychain_output = root / "keychain-output.ipa"
    app(keychain_input)
    with zipfile.ZipFile(keychain_input, "a") as archive:
      archive.writestr("Payload/Test.app/Frameworks/Outer.framework/Frameworks/Inner.dylib", b"inner")
      archive.writestr("Payload/Test.app/Frameworks/Outer.framework/Outer", b"framework")
      archive.writestr("__MACOSX/scratch", b"extraneous")
    sign(None, keychain, keychain_input, keychain_output, UDID, "27.0.1")
    assert [Path(command[-1]).name for command in codesign_calls] == [
      "Inner.dylib", "Outer.framework", "Test.app", "Test.app",
    ]
    with zipfile.ZipFile(keychain_output) as archive:
      assert all(member.startswith("Payload/Test.app/") for member in archive.namelist())
      assert archive.read("Payload/Test.app/embedded.mobileprovision") == prof

  with patch("ipa_signer.subprocess.run", side_effect=lambda command, **kwargs:
      subprocess.CompletedProcess(command, 0, b"0 valid identities found")
      if command[0] == "/usr/bin/security" else real_run(command, **kwargs)):
    bad_keychain_policy()

  # A test slot accepts new uploads without an allowlist and changes only the root bundle identity.
  with patch("ipa_signer.subprocess.run", side_effect=keychain_tools):
    slot_values = {name: value for name, value in keychain_values.items() if name != "allowedIpaSha256"}
    slot_values.update(rebindBundleId=True, identitySha1=identity)
    keychain_policy_file.write_text(json.dumps({**slot_values, "rebindBundleId": False}))
    bad_keychain_policy()
    keychain_policy_file.write_text(json.dumps({**slot_values, "allowedIpaSha256": [signed_digest]}))
    bad_keychain_policy()
    keychain_policy_file.write_text(json.dumps(slot_values))
    bad_keychain_policy(use_keychain=False)
    (root / "entitlements.plist").write_bytes(plistlib.dumps({
      **ENTITLEMENTS, "keychain-access-groups": [TEAM + ".other"],
    }))
    bad_keychain_policy()
    (root / "entitlements.plist").write_bytes(plistlib.dumps(ENTITLEMENTS))
    slot = Policy(keychain_policy_file, use_keychain=True)
    slot_source = root / "never-allowlisted.ipa"
    app(slot_source, bundle="app.original.dev", version="2.1.3", plist_format=plistlib.FMT_BINARY)
    incoming = slot_source.read_bytes()
    codesign_calls.clear()
    with SignerServer(("127.0.0.1", 0), None, slot, TOKEN) as server:
      thread = threading.Thread(target=server.serve_forever, daemon=True)
      thread.start()
      try:
        status, _, body = request(server, incoming, **{"X-STF-IPA-SHA256": "0" * 64})
        assert (status, json.loads(body)["error"]) == (400, "IOS_IPA_SIGNING_INVALID_REQUEST")
        status, _, body = request(server, signed.read_bytes())
        assert (status, json.loads(body)["error"]) == (403, "IOS_IPA_SIGNING_NOT_ALLOWED")
        assert not codesign_calls
        status, headers, body = request(server, incoming)
        assert status == 200, (status, body)
        assert headers["X-STF-IPA-SHA256"] == hashlib.sha256(body).hexdigest()
      finally:
        server.shutdown()
        thread.join(timeout=10)
    (root / "slot-result.ipa").write_bytes(body)
    with zipfile.ZipFile(root / "slot-result.ipa") as archive:
      output_info = archive.read("Payload/Test.app/Info.plist")
      assert output_info.startswith(b"bplist00")
      assert archive.read("Payload/Test.app/embedded.mobileprovision") == prof
    with zipfile.ZipFile(slot_source) as archive:
      input_info = plistlib.loads(archive.read("Payload/Test.app/Info.plist"))
      assert input_info["CFBundleIdentifier"] == "app.original.dev"
    assert plistlib.loads(output_info) == {**input_info, "CFBundleIdentifier": BUNDLE}
    assert slot_source.read_bytes() == incoming

  result = root / "chosen-result.ipa"
  result.write_bytes(signed.read_bytes())
  fake = root / "fake-zsign"
  fake.write_text("#!" + sys.executable + "\n" + """
from pathlib import Path
import plistlib
import shutil
import sys
args = sys.argv[1:]
assert set(args[::2][1:-1]) == {'-k', '-c', '-m', '-e', '-t', '-o'}
assert args[:2] == ['-f', '-q']
key = Path(args[args.index('-k')+1])
scratch = Path(args[args.index('-t')+1])
assert (key.stat().st_mode & 0o777) == 0o600
assert key.parent != scratch and not any(scratch.iterdir())
assert plistlib.loads(Path(args[args.index('-e')+1]).read_bytes())['application-identifier'] == """ + repr(ENTITLEMENTS["application-identifier"]) + """
with open(""" + repr(str(calls)) + """, 'a') as stream:
  stream.write('sign\\n')
shutil.copyfile(""" + repr(str(result)) + """, args[args.index('-o')+1])
""")
  fake.chmod(0o700)

  with SignerServer(("127.0.0.1", 0), str(fake), policy, TOKEN) as server:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
      cases = [
        (source, {"Authorization": "Bearer wrong"}, 401, "IOS_IPA_SIGNING_UNAUTHORIZED"),
        (source, {"X-STF-IPA-UDID": OTHER_UDID}, 403, "IOS_IPA_SIGNING_NOT_ALLOWED"),
        (source, {"X-STF-IPA-SHA256": "0" * 64}, 403, "IOS_IPA_SIGNING_NOT_ALLOWED"),
        (source, {"X-STF-IPA-SHA256": signed_digest}, 400, "IOS_IPA_SIGNING_INVALID_REQUEST"),
        (other, {}, 403, "IOS_IPA_SIGNING_NOT_ALLOWED"),
        (signed, {}, 403, "IOS_IPA_SIGNING_NOT_ALLOWED"),
      ]
      for path, overrides, expected_status, expected_code in cases:
        status, _, body = request(server, path.read_bytes(), **overrides)
        assert (status, json.loads(body)["error"]) == (expected_status, expected_code), (status, body)
      assert not calls.exists()
      status, headers, body = request(server, source.read_bytes())
      assert status == 200 and body == signed.read_bytes(), (status, body)
      assert headers["X-STF-IPA-SHA256"] == hashlib.sha256(body).hexdigest()
      assert calls.read_text() == "sign\n"

      app(result, prof, version="2.0")
      status, _, body = request(server, source.read_bytes())
      assert status == 502 and json.loads(body)["error"] == "IOS_IPA_SIGNING_FAILED", (status, body)

      policy.expires = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
      status, _, body = request(server, source.read_bytes())
      assert status == 422 and json.loads(body)["error"] == "IOS_IPA_SIGNING_PROFILE_INVALID"
      assert calls.read_text() == "sign\nsign\n"
    finally:
      server.shutdown()
      thread.join(timeout=10)

print("IPA signer HTTP fixtures passed")

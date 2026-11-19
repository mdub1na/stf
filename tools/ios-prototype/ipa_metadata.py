"""Bounded IPA preflight. iOS remains responsible for final code-signature verification."""
import datetime
import json
import pathlib
import re
import stat
import struct
import subprocess
import sys
import unicodedata
import zipfile


class InvalidIpa(Exception):
  pass


def require(condition, code):
  if not condition:
    raise InvalidIpa(code)


ARM64 = 0x0100000C
MACHO64_LE = b"\xcf\xfa\xed\xfe"
FAT32_BE = b"\xca\xfe\xba\xbe"
FAT64_BE = b"\xca\xfe\xba\xbf"


def unsigned_executable(stream, file_size):
  """Prove that each executable slice targets a device and carries no signature."""
  def read_at(offset, size):
    require(offset >= 0 and offset + size <= file_size, "IOS_IPA_INVALID")
    stream.seek(offset)
    data = stream.read(size)
    require(len(data) == size, "IOS_IPA_INVALID")
    return data

  magic = read_at(0, 4)
  if magic == MACHO64_LE:
    slices = [(0, file_size, None)]
  else:
    require(magic in (FAT32_BE, FAT64_BE), "IOS_IPA_PLATFORM")
    count = struct.unpack(">I", read_at(4, 4))[0]
    require(0 < count <= 32, "IOS_IPA_INVALID")
    wide = magic == FAT64_BE
    stride = 32 if wide else 20
    table = read_at(8, count * stride)
    slices = []
    for index in range(count):
      cpu, subtype, offset, size, align = struct.unpack_from(
          ">IIQQI" if wide else ">IIIII", table, index * stride)
      require(cpu == ARM64, "IOS_IPA_PLATFORM")
      require(offset >= 8 + len(table) and size >= 32 and offset + size <= file_size and
          align <= 31 and offset % (1 << align) == 0, "IOS_IPA_INVALID")
      slices.append((offset, size, subtype))
    slices.sort()
    require(all(offset + size <= next_offset
        for (offset, size, _), (next_offset, _, _) in zip(slices, slices[1:])), "IOS_IPA_INVALID")

  for offset, size, expected_subtype in slices:
    require(size >= 32, "IOS_IPA_INVALID")
    header = read_at(offset, 32)
    require(header[:4] == MACHO64_LE, "IOS_IPA_PLATFORM")
    cpu, subtype, file_type, count, command_bytes = struct.unpack_from("<5I", header, 4)
    require(cpu == ARM64 and file_type == 2, "IOS_IPA_PLATFORM")  # MH_EXECUTE
    require(expected_subtype is None or subtype == expected_subtype, "IOS_IPA_INVALID")
    require(0 < count <= command_bytes // 8 and command_bytes <= min(size - 32, 1024 * 1024),
        "IOS_IPA_INVALID")
    commands = read_at(offset + 32, command_bytes)
    cursor = 0
    device_platform = False
    for _ in range(count):
      require(cursor + 8 <= len(commands), "IOS_IPA_INVALID")
      kind, length = struct.unpack_from("<II", commands, cursor)
      require(length >= 8 and length % 8 == 0 and cursor + length <= len(commands), "IOS_IPA_INVALID")
      if kind == 0x1D:  # LC_CODE_SIGNATURE, including ad hoc signatures
        raise InvalidIpa("IOS_IPA_SIGNING")
      if kind == 0x32:  # LC_BUILD_VERSION
        require(length >= 24, "IOS_IPA_INVALID")
        platform, _, _, tools = struct.unpack_from("<4I", commands, cursor + 8)
        require(length == 24 + tools * 8, "IOS_IPA_INVALID")
        require(platform == 2, "IOS_IPA_PLATFORM")  # PLATFORM_IOS, not IOS_SIMULATOR
        device_platform = True
      elif kind == 0x25:  # LC_VERSION_MIN_IPHONEOS
        require(length == 16, "IOS_IPA_INVALID")
        device_platform = True
      elif kind in (0x24, 0x2F, 0x30):  # macOS, tvOS, watchOS
        raise InvalidIpa("IOS_IPA_PLATFORM")
      elif kind in (0x21, 0x2C):  # LC_ENCRYPTION_INFO(_64)
        require(length >= 20, "IOS_IPA_INVALID")
        crypt_offset, crypt_size, crypt_id = struct.unpack_from("<3I", commands, cursor + 8)
        require(crypt_offset + crypt_size <= size, "IOS_IPA_INVALID")
        require(crypt_id == 0, "IOS_IPA_SIGNING_UNSUPPORTED")
      cursor += length
    require(cursor == len(commands), "IOS_IPA_INVALID")
    require(device_platform, "IOS_IPA_PLATFORM")


def unsigned_archive(entries, root):
  paths = {}
  files = set()
  folded_root = unicodedata.normalize("NFC", root).casefold().rstrip("/")
  for entry in entries:
    name = entry.filename.rstrip("/")
    parts = pathlib.PurePosixPath(name).parts
    kind = stat.S_IFMT(entry.external_attr >> 16)
    require(name and "/".join(parts) == name and "\0" not in entry.orig_filename and
        kind in (0, stat.S_IFREG, stat.S_IFDIR) and
        (kind == 0 or (kind == stat.S_IFDIR) == entry.is_dir()), "IOS_IPA_INVALID")
    folded = unicodedata.normalize("NFC", name).casefold()
    require(folded not in paths, "IOS_IPA_INVALID")
    paths[folded] = name
    if not entry.is_dir():
      files.add(folded)
    if folded.startswith("payload/"):
      require(folded == folded_root or folded.startswith(folded_root + "/"), "IOS_IPA_INVALID")
    if folded.startswith(folded_root + "/"):
      require(entry.filename.startswith(root), "IOS_IPA_INVALID")
      nested = pathlib.PurePosixPath(entry.filename[len(root):]).parts
      require(not nested or (nested[0].casefold() not in ("plugins", "watch", "appclips") and
          not any(part.casefold().endswith((".app", ".appex")) for part in nested)),
          "IOS_IPA_SIGNING_UNSUPPORTED")
  parents = {}
  for folded, name in paths.items():
    parent, _, _ = folded.rpartition("/")
    actual, _, _ = name.rpartition("/")
    while parent:
      require(parent not in files and paths.get(parent, actual) == actual and
          parents.setdefault(parent, actual) == actual, "IOS_IPA_INVALID")
      parent, _, _ = parent.rpartition("/")
      actual, _, _ = actual.rpartition("/")


def inspect(filename, udid, ios_version, allow_unsigned=False):
  with zipfile.ZipFile(filename) as archive:
    entries = archive.infolist()
    require(0 < len(entries) <= 20000, "IOS_IPA_INVALID")
    names = set()
    total = 0
    for entry in entries:
      name = entry.filename
      path = pathlib.PurePosixPath(name)
      require(not path.is_absolute() and ".." not in path.parts and "\\" not in name
          and "\0" not in name and name not in names, "IOS_IPA_INVALID")
      require(not stat.S_ISLNK(entry.external_attr >> 16), "IOS_IPA_INVALID")
      require(not entry.flag_bits & 1, "IOS_IPA_INVALID")
      names.add(name)
      total += entry.file_size
    require(total <= 3 * 1024 ** 3, "IOS_IPA_TOO_LARGE")
    roots = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
    require(len(roots) == 1, "IOS_IPA_INVALID")
    root = roots[0][:-len("Info.plist")]

    def read(name, limit):
      require(name in names and archive.getinfo(name).file_size <= limit, "IOS_IPA_INVALID")
      return archive.read(name)

    import plistlib
    info = plistlib.loads(read(root + "Info.plist", 1024 * 1024))
    bundle = info.get("CFBundleIdentifier", "")
    require(isinstance(bundle, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,254}", bundle),
        "IOS_IPA_INVALID")
    require(info.get("CFBundlePackageType") == "APPL", "IOS_IPA_INVALID")
    require("iPhoneOS" in info.get("CFBundleSupportedPlatforms", []), "IOS_IPA_PLATFORM")
    require(1 in info.get("UIDeviceFamily", [1]), "IOS_IPA_PLATFORM")
    minimum = info.get("MinimumOSVersion", "0")

    def version(value):
      require(isinstance(value, str) and re.fullmatch(r"\d+(\.\d+){0,3}", value),
          "IOS_IPA_INVALID")
      return tuple(int(p) for p in value.split(".")) + (0,) * (4 - len(value.split(".")))

    require(version(minimum) <= version(ios_version), "IOS_IPA_OS_VERSION")
    executable = info.get("CFBundleExecutable", "")
    require(isinstance(executable, str) and executable not in ("", ".", "..")
        and "/" not in executable and "\\" not in executable, "IOS_IPA_INVALID")
    executable_path = root + executable
    require(executable_path in names, "IOS_IPA_INVALID")
    with archive.open(executable_path) as stream:
      header = stream.read(4096)
    require(len(header) >= 8, "IOS_IPA_PLATFORM")
    magic = header[:4]
    if magic in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
      arm64 = struct.unpack_from("<I", header, 4)[0] == 0x0100000C
    elif magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
      count = struct.unpack_from(">I", header, 4)[0]
      stride = 20 if magic[-1] == 0xBE else 32
      require(count <= 32 and 8 + count * stride <= len(header), "IOS_IPA_PLATFORM")
      arm64 = any(struct.unpack_from(">I", header, 8 + i * stride)[0] == 0x0100000C
            for i in range(count))
    else:
      arm64 = False
    require(arm64, "IOS_IPA_PLATFORM")
    resources = root + "_CodeSignature/CodeResources" in names
    embedded = root + "embedded.mobileprovision" in names
    manifest = {"package": bundle, "name": str(info.get("CFBundleDisplayName") or
        info.get("CFBundleName") or bundle)[:255],
        "version": str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or ""),
        "minimumOSVersion": minimum}
    if allow_unsigned and not resources and not embedded:
      root_folded = root.casefold()
      require(not any(name.casefold().startswith(root_folded + "_codesignature/") or
          name.casefold().rstrip("/") in (root_folded + "_codesignature",
              root_folded + "embedded.mobileprovision") for name in names), "IOS_IPA_SIGNING")
      unsigned_archive(entries, root)
      with archive.open(executable_path) as stream:
        unsigned_executable(stream, archive.getinfo(executable_path).file_size)
      return {**manifest, "profileExpiresAt": None, "signature": "unsigned"}
    require(resources and embedded, "IOS_IPA_SIGNING")
    profile_bytes = read(root + "embedded.mobileprovision", 4 * 1024 * 1024)
    decoded = subprocess.run(["openssl", "cms", "-verify", "-inform", "DER", "-noverify"],
                input=profile_bytes, capture_output=True, timeout=10)
    require(decoded.returncode == 0, "IOS_IPA_SIGNING")
    profile = plistlib.loads(decoded.stdout)
    expires = profile.get("ExpirationDate")
    require(isinstance(expires, datetime.datetime), "IOS_IPA_SIGNING")
    expires = expires.replace(tzinfo=datetime.timezone.utc)
    require(expires > datetime.datetime.now(datetime.timezone.utc), "IOS_IPA_PROFILE_EXPIRED")
    allowed = profile.get("ProvisionedDevices", [])
    require(profile.get("ProvisionsAllDevices") is True or
        udid.lower() in [value.lower() for value in allowed if isinstance(value, str)],
        "IOS_IPA_DEVICE_NOT_PROVISIONED")
    app_id = profile.get("Entitlements", {}).get("application-identifier", "")
    require(isinstance(app_id, str) and "." in app_id, "IOS_IPA_SIGNING")
    identifier = app_id.split(".", 1)[1]
    require(identifier == bundle or (identifier.endswith("*") and
        "*" not in identifier[:-1] and bundle.startswith(identifier[:-1])), "IOS_IPA_SIGNING")
    manifest["profileExpiresAt"] = expires.isoformat()
    if allow_unsigned:
      manifest["signature"] = "signed"
    return manifest


if __name__ == "__main__":
  try:
    arguments = sys.argv[1:]
    allow_unsigned = arguments[3:] == ["--allow-unsigned"]
    require(len(arguments) == (4 if allow_unsigned else 3), "IOS_IPA_INVALID")
    print(json.dumps({"manifest": inspect(*arguments[:3], allow_unsigned=allow_unsigned)}))
  except InvalidIpa as error:
    print(json.dumps({"error": str(error)}))
  except Exception:
    print(json.dumps({"error": "IOS_IPA_INVALID"}))

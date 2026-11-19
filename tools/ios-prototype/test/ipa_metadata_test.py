"""Synthetic signatures are test data, never valid Apple signing identities."""
import datetime
import importlib.util
import pathlib
import plistlib
import struct
import subprocess
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("metadata", pathlib.Path(__file__).parents[1] / "ipa_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)

CPU_ARM64 = 0x0100000C
BUILD_IOS = struct.pack("<6I", 0x32, 24, 2, 0x00120000, 0x001B0000, 0)


def macho(*commands, subtype=0):
  table = b"".join(commands)
  return struct.pack("<8I", 0xFEEDFACF, CPU_ARM64, subtype, 2, len(commands), len(table), 0, 0) + table


def fat(*slices, wide=False):
  table = bytearray(struct.pack(">II", 0xCAFEBABF if wide else 0xCAFEBABE, len(slices)))
  offset = 8 + (32 if wide else 20) * len(slices)
  for subtype, binary in slices:
    if wide:
      table.extend(struct.pack(">IIQQII", CPU_ARM64, subtype, offset, len(binary), 0, 0))
    else:
      table.extend(struct.pack(">IIIII", CPU_ARM64, subtype, offset, len(binary), 0))
    offset += len(binary)
  return bytes(table) + b"".join(binary for _, binary in slices)


def reject(filename, code, allow_unsigned=False):
  try:
    metadata.inspect(filename, "phone-123", "27.0.1", allow_unsigned=allow_unsigned)
  except metadata.InvalidIpa as error:
    assert str(error) == code, (str(error), code)
  else:
    raise AssertionError("Expected " + code)


with tempfile.TemporaryDirectory() as directory:
  root = pathlib.Path(directory)
  key, cert = root / "test.key", root / "test.crt"
  expiry = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(days=1)
  subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
          "-subj", "/CN=STF fixture only", "-keyout", str(key), "-out", str(cert)],
         check=True, capture_output=True)

  def ipa(info_changes=None, profile_changes=None, extra=None, binary=None, unsigned=False):
    info = {"CFBundleIdentifier": "test.stf.app", "CFBundleExecutable": "TestApp",
        "CFBundlePackageType": "APPL", "CFBundleSupportedPlatforms": ["iPhoneOS"],
        "UIDeviceFamily": [1], "MinimumOSVersion": "18.0", "CFBundleName": "STF Test",
        "CFBundleShortVersionString": "1.2", **(info_changes or {})}
    profile = {"ExpirationDate": expiry, "ProvisionedDevices": ["phone-123"],
         "Entitlements": {"application-identifier": "TEAM.test.stf.*"},
         **(profile_changes or {})}
    signed = subprocess.run(["openssl", "cms", "-sign", "-binary", "-nodetach", "-outform", "DER",
                "-signer", str(cert), "-inkey", str(key)], input=plistlib.dumps(profile),
                check=True, capture_output=True).stdout
    filename = root / "test.ipa"
    with zipfile.ZipFile(filename, "w") as archive:
      app = "Payload/Test.app/"
      archive.writestr(app + "Info.plist", plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
      archive.writestr(app + "TestApp", macho(BUILD_IOS) if binary is None else binary)
      if not unsigned:
        archive.writestr(app + "_CodeSignature/CodeResources", b"fixture")
        archive.writestr(app + "embedded.mobileprovision", signed)
      for name, value in (extra or {}).items():
        archive.writestr(name, value)
    return filename

  expected_signed = metadata.inspect(ipa(), "PHONE-123", "27.0.1")
  assert expected_signed["package"] == "test.stf.app"
  assert "signature" not in expected_signed
  assert metadata.inspect(ipa(), "PHONE-123", "27.0.1", allow_unsigned=True) == {
      **expected_signed, "signature": "signed"}
  expected_unsigned = {**expected_signed, "profileExpiresAt": None, "signature": "unsigned"}
  for binary in (macho(BUILD_IOS), macho(struct.pack("<4I", 0x25, 16, 0x000A0000, 0x000B0000)),
      fat((0, macho(BUILD_IOS)), (2, macho(BUILD_IOS, subtype=2))),
      fat((0, macho(BUILD_IOS)), wide=True)):
    assert metadata.inspect(ipa(unsigned=True, binary=binary), "phone-123", "27.0.1",
        allow_unsigned=True) == expected_unsigned
  cases = [
    ({"info_changes": {"CFBundleSupportedPlatforms": ["iPhoneSimulator"]}}, "IOS_IPA_PLATFORM"),
    ({"info_changes": {"UIDeviceFamily": [2]}}, "IOS_IPA_PLATFORM"),
    ({"info_changes": {"MinimumOSVersion": "99.0"}}, "IOS_IPA_OS_VERSION"),
    ({"binary": struct.pack("<II", 0xFEEDFACF, 0x01000007)}, "IOS_IPA_PLATFORM"),
    ({"unsigned": True}, "IOS_IPA_SIGNING"),
    ({"profile_changes": {"ProvisionedDevices": ["other-phone"]}}, "IOS_IPA_DEVICE_NOT_PROVISIONED"),
    ({"profile_changes": {"ExpirationDate": datetime.datetime(2000, 1, 1)}}, "IOS_IPA_PROFILE_EXPIRED"),
    ({"profile_changes": {"Entitlements": {"application-identifier": "TEAM.other.app"}}}, "IOS_IPA_SIGNING"),
    ({"extra": {"../../outside": b"escape"}}, "IOS_IPA_INVALID"),
    ({"extra": {"Payload/Other.app/Info.plist": b"second-app"}}, "IOS_IPA_INVALID"),
    ({"info_changes": {"CFBundleExecutable": "../escape"}}, "IOS_IPA_INVALID"),
  ]
  for arguments, code in cases:
    reject(ipa(**arguments), code)
    if arguments != {"unsigned": True}:
      reject(ipa(**arguments), code, allow_unsigned=True)

  disk_signed = struct.pack("<4I", 0x1D, 16, 0, 0)
  overlapping = bytearray(fat((0, macho(BUILD_IOS)), (2, macho(BUILD_IOS, subtype=2))))
  struct.pack_into(">I", overlapping, 36, 48)
  invalid_unsigned = [
    ({"binary": macho(BUILD_IOS, disk_signed)}, "IOS_IPA_SIGNING"),
    ({"binary": fat((0, macho(BUILD_IOS)), (2, macho(BUILD_IOS, disk_signed, subtype=2)))},
        "IOS_IPA_SIGNING"),
    ({"binary": macho(struct.pack("<6I", 0x32, 24, 7, 0, 0, 0))}, "IOS_IPA_PLATFORM"),
    ({"binary": macho(struct.pack("<2I", 0x2, 8))}, "IOS_IPA_PLATFORM"),
    ({"binary": macho(BUILD_IOS, struct.pack("<6I", 0x2C, 24, 0, 0, 1, 0))},
        "IOS_IPA_SIGNING_UNSUPPORTED"),
    ({"binary": macho(BUILD_IOS, struct.pack("<2I", 0x2, 0))}, "IOS_IPA_INVALID"),
    ({"binary": macho(BUILD_IOS)[:-1]}, "IOS_IPA_INVALID"),
    ({"binary": fat((0, macho(BUILD_IOS)), wide=True)[:-1]}, "IOS_IPA_INVALID"),
    ({"binary": bytes(overlapping)}, "IOS_IPA_INVALID"),
    ({"extra": {"Payload/Test.app/_CodeSignature/CodeResources": b"partial"}}, "IOS_IPA_SIGNING"),
    ({"extra": {"Payload/Test.app/embedded.mobileprovision": b"partial"}}, "IOS_IPA_SIGNING"),
    ({"extra": {"Payload/Test.app/_CodeSignature/": b""}}, "IOS_IPA_SIGNING"),
    ({"extra": {"Payload/Test.app/PlugIns/Widget.appex/Info.plist": b"widget"}},
        "IOS_IPA_SIGNING_UNSUPPORTED"),
    ({"extra": {"Payload/Test.app/Watch/Companion.app/Info.plist": b"watch"}},
        "IOS_IPA_SIGNING_UNSUPPORTED"),
    ({"extra": {"Payload/Test.app/AppClips/Clip.app/Info.plist": b"clip"}},
        "IOS_IPA_SIGNING_UNSUPPORTED"),
    ({"extra": {"Payload/Test.APP/PlugIns/Widget.appex/Info.plist": b"case-alias"}}, "IOS_IPA_INVALID"),
    ({"extra": {"Payload/Other.APP/Other": b"second-app"}}, "IOS_IPA_INVALID"),
    ({"extra": {"Payload/Test.app/assets": b"file", "Payload/Test.app/assets/image.png": b"image"}},
        "IOS_IPA_INVALID"),
  ]
  for arguments, code in invalid_unsigned:
    reject(ipa(**arguments, unsigned=True), code, allow_unsigned=True)
  print("IPA signed and unsigned preflight fixtures passed")

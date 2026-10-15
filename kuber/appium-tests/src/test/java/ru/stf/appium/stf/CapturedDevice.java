package ru.stf.appium.stf;

public record CapturedDevice(
    String serial,
    String model,
    String platform,
    String provider,
    String remoteConnectUrl
) {
}

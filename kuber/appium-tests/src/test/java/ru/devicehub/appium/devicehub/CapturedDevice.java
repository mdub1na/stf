package ru.devicehub.appium.devicehub;

public record CapturedDevice(
    String serial,
    String model,
    String platform,
    String provider,
    String remoteConnectUrl
) {
}

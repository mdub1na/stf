package ru.devicehub.appium.devicehub;

public record DeviceHubCaptureRequest(
    int amount,
    int timeoutSeconds,
    boolean needAmount,
    String run,
    String type,
    String abi,
    String model,
    String sdk,
    String version
) {
}

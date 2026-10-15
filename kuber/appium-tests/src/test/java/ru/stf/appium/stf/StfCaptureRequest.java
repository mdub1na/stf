package ru.stf.appium.stf;

public record StfCaptureRequest(
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

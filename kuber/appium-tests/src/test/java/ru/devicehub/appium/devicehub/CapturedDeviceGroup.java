package ru.devicehub.appium.devicehub;

import java.util.List;

public record CapturedDeviceGroup(
    String id,
    String name,
    List<CapturedDevice> devices
) {
}

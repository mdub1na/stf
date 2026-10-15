package ru.stf.appium.stf;

import java.util.List;

public record CapturedDeviceGroup(
    String id,
    String name,
    List<CapturedDevice> devices
) {
}

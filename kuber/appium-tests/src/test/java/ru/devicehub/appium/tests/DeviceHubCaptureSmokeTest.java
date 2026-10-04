package ru.devicehub.appium.tests;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import ru.devicehub.appium.config.TestConfig;
import ru.devicehub.appium.devicehub.CapturedDeviceGroup;
import ru.devicehub.appium.devicehub.DeviceHubCaptureRequest;
import ru.devicehub.appium.devicehub.DeviceHubClient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class DeviceHubCaptureSmokeTest {
    @Test
    @Tag("devicehub")
    void capturesAndFreesAndroidDevice() {
        DeviceHubClient client = new DeviceHubClient(TestConfig.deviceHubBaseUrl(), TestConfig.deviceHubToken());
        DeviceHubCaptureRequest request = new DeviceHubCaptureRequest(
            TestConfig.deviceHubAmount(),
            TestConfig.deviceHubTimeoutSeconds(),
            TestConfig.deviceHubNeedAmount(),
            TestConfig.deviceHubRunName(),
            TestConfig.deviceHubDeviceType(),
            TestConfig.deviceHubAbi(),
            TestConfig.deviceHubModel(),
            TestConfig.deviceHubSdk(),
            TestConfig.deviceHubVersion()
        );

        CapturedDeviceGroup group = client.captureDevices(request);
        try {
            assertFalse(group.id().isBlank(), "Captured group id should not be blank");
            assertEquals(TestConfig.deviceHubAmount(), group.devices().size(), "Unexpected captured devices amount");

            group.devices().forEach(device -> {
                assertFalse(device.serial().isBlank(), "Captured device serial should not be blank");
                System.out.printf(
                    "Captured DeviceHub device: serial=%s model=%s remoteConnectUrl=%s%n",
                    device.serial(),
                    device.model(),
                    device.remoteConnectUrl()
                );
            });
        }
        finally {
            client.freeDevices(group.id());
        }
    }
}

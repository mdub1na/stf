package ru.stf.appium.tests;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import ru.stf.appium.config.TestConfig;
import ru.stf.appium.stf.CapturedDeviceGroup;
import ru.stf.appium.stf.StfCaptureRequest;
import ru.stf.appium.stf.StfClient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class StfCaptureSmokeTest {
    @Test
    @Tag("stf")
    void capturesAndFreesAndroidDevice() {
        StfClient client = new StfClient(TestConfig.stfBaseUrl(), TestConfig.stfToken());
        StfCaptureRequest request = new StfCaptureRequest(
            TestConfig.stfAmount(),
            TestConfig.stfTimeoutSeconds(),
            TestConfig.stfNeedAmount(),
            TestConfig.stfRunName(),
            TestConfig.stfDeviceType(),
            TestConfig.stfAbi(),
            TestConfig.stfModel(),
            TestConfig.stfSdk(),
            TestConfig.stfVersion()
        );

        CapturedDeviceGroup group = client.captureDevices(request);
        try {
            assertFalse(group.id().isBlank(), "Captured group id should not be blank");
            assertEquals(TestConfig.stfAmount(), group.devices().size(), "Unexpected captured devices amount");

            group.devices().forEach(device -> {
                assertFalse(device.serial().isBlank(), "Captured device serial should not be blank");
                System.out.printf(
                    "Captured Stf device: serial=%s model=%s remoteConnectUrl=%s%n",
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

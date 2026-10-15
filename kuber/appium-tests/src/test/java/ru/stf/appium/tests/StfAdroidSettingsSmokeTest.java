package ru.stf.appium.tests;

import io.appium.java_client.android.AndroidDriver;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import ru.stf.appium.config.TestConfig;
import ru.stf.appium.stf.CapturedDevice;
import ru.stf.appium.stf.CapturedDeviceGroup;
import ru.stf.appium.stf.StfCaptureRequest;
import ru.stf.appium.stf.StfClient;
import ru.stf.appium.support.AppiumTestExtension;
import ru.stf.appium.support.DriverFactory;

import static org.junit.jupiter.api.Assertions.assertFalse;

class StfAdroidSettingsSmokeTest {
    private AndroidDriver driver;

    @RegisterExtension
    final AppiumTestExtension appiumTestExtension = new AppiumTestExtension(() -> driver);

    @Test
    @Tag("stf-appium-settings")
    void capturesDeviceAndOpensAndroidSettings() {
        StfClient client = new StfClient(TestConfig.stfBaseUrl(), TestConfig.stfToken());
        CapturedDeviceGroup group = client.captureDevices(captureRequest());

        try {
            assertFalse(group.devices().isEmpty(), "Stf should capture at least one device");

            CapturedDevice device = group.devices().get(0);
            assertFalse(device.serial().isBlank(), "Captured device serial should not be blank");
            System.out.printf(
                "Running Settings smoke on Stf device: serial=%s model=%s provider=%s remoteConnectUrl=%s%n",
                device.serial(),
                device.model(),
                device.provider(),
                device.remoteConnectUrl()
            );

            driver = DriverFactory.createAndroidSettingsDriver(device);
            assertFalse(driver.getPageSource().isBlank(), "Settings page source should not be blank");
        }
        finally {
            client.freeDevices(group.id());
        }
    }

    private StfCaptureRequest captureRequest() {
        return new StfCaptureRequest(
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
    }
}

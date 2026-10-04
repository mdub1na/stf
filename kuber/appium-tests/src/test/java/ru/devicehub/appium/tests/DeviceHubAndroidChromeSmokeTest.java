package ru.devicehub.appium.tests;

import io.appium.java_client.android.AndroidDriver;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import ru.devicehub.appium.config.TestConfig;
import ru.devicehub.appium.devicehub.CapturedDevice;
import ru.devicehub.appium.devicehub.CapturedDeviceGroup;
import ru.devicehub.appium.devicehub.DeviceHubCaptureRequest;
import ru.devicehub.appium.devicehub.DeviceHubClient;
import ru.devicehub.appium.support.AppiumTestExtension;
import ru.devicehub.appium.support.DriverFactory;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DeviceHubAndroidChromeSmokeTest {
    private AndroidDriver driver;

    @RegisterExtension
    final AppiumTestExtension appiumTestExtension = new AppiumTestExtension(() -> driver);

    @Test
    @Tag("devicehub-appium")
    void capturesDeviceAndOpensExampleComInChrome() {
        DeviceHubClient client = new DeviceHubClient(TestConfig.deviceHubBaseUrl(), TestConfig.deviceHubToken());
        CapturedDeviceGroup group = client.captureDevices(captureRequest());

        try {
            assertFalse(group.devices().isEmpty(), "DeviceHub should capture at least one device");

            CapturedDevice device = group.devices().get(0);
            assertFalse(device.serial().isBlank(), "Captured device serial should not be blank");
            System.out.printf(
                "Running Appium smoke on DeviceHub device: serial=%s model=%s provider=%s remoteConnectUrl=%s%n",
                device.serial(),
                device.model(),
                device.provider(),
                device.remoteConnectUrl()
            );

            driver = DriverFactory.createAndroidBrowserDriver(device);
            driver.get(TestConfig.targetUrl());

            WebDriverWait wait = new WebDriverWait(driver, TestConfig.explicitWait());
            wait.until(ExpectedConditions.titleContains("Example"));

            assertTrue(driver.getTitle().contains("Example"), "Expected browser title to contain 'Example'");
        }
        finally {
            client.freeDevices(group.id());
        }
    }

    private DeviceHubCaptureRequest captureRequest() {
        return new DeviceHubCaptureRequest(
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
    }
}

package ru.stf.appium.tests;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.appium.java_client.ios.IOSDriver;
import org.junit.jupiter.api.Assumptions;
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

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StfIosSettingsSmokeTest {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private IOSDriver driver;

    @RegisterExtension
    final AppiumTestExtension appiumTestExtension = new AppiumTestExtension(() -> driver);

    @Test
    @Tag("stf-appium-ios-settings")
    void capturesDeviceAndOpensIosSettings() {
        Assumptions.assumeTrue(gridHasIosSlot(), "Appium Grid does not have registered iOS/XCUITest slots");

        StfClient client = new StfClient(TestConfig.stfBaseUrl(), TestConfig.stfToken());
        CapturedDeviceGroup group = client.captureDevices(captureRequest());

        try {
            assertFalse(group.devices().isEmpty(), "Stf should capture at least one iOS device");

            CapturedDevice device = group.devices().get(0);
            assertFalse(device.serial().isBlank(), "Captured iOS device serial should not be blank");
            assertTrue("iOS".equalsIgnoreCase(device.platform()), "Captured device should be iOS");
            System.out.printf(
                "Running iOS Settings smoke on Stf device: serial=%s model=%s provider=%s remoteConnectUrl=%s%n",
                device.serial(),
                device.model(),
                device.provider(),
                device.remoteConnectUrl()
            );

            driver = DriverFactory.createIosSettingsDriver(device);
            assertFalse(driver.getPageSource().isBlank(), "iOS Settings page source should not be blank");
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
            TestConfig.stfIosModel(),
            TestConfig.stfSdk(),
            TestConfig.stfVersion()
        );
    }

    private boolean gridHasIosSlot() {
        HttpClient httpClient = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder(URI.create(TestConfig.appiumServerUrl().toString()).resolve("/status"))
            .GET()
            .build();

        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return false;
            }

            JsonNode nodes = OBJECT_MAPPER.readTree(response.body()).path("value").path("nodes");
            for (JsonNode node : nodes) {
                for (JsonNode slot : node.path("slots")) {
                    String platformName = slot.path("stereotype").path("platformName").asText("");
                    if ("iOS".equalsIgnoreCase(platformName)) {
                        return true;
                    }
                }
            }
            return false;
        }
        catch (IOException | InterruptedException err) {
            if (err instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }
}

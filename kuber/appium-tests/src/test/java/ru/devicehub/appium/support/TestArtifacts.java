package ru.devicehub.appium.support;

import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import ru.devicehub.appium.config.TestConfig;

public final class TestArtifacts {
    private static final DateTimeFormatter FILE_TIMESTAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private TestArtifacts() {
    }

    public static void saveFailureArtifacts(AppiumDriver driver, String testName) {
        if (driver == null) {
            return;
        }

        Path testDir = TestConfig.artifactsDir().resolve(safeName(testName) + "-" + FILE_TIMESTAMP.format(LocalDateTime.now()));
        try {
            Files.createDirectories(testDir);
            Files.writeString(testDir.resolve("page-source.xml"), driver.getPageSource(), StandardCharsets.UTF_8);
            byte[] screenshot = ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
            Files.write(testDir.resolve("screenshot.png"), screenshot);
        }
        catch (IOException | RuntimeException err) {
            System.err.println("Failed to save Appium artifacts: " + err.getMessage());
        }
    }

    private static String safeName(String value) {
        return value.replaceAll("[^A-Za-z0-9_.-]", "_");
    }
}

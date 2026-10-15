package ru.stf.appium.tests;

import io.appium.java_client.android.AndroidDriver;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.api.Test;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import ru.stf.appium.config.TestConfig;
import ru.stf.appium.support.DriverFactory;
import ru.stf.appium.support.AppiumTestExtension;

import static org.junit.jupiter.api.Assertions.assertTrue;

class AndroidChromeSmokeTest {
    private AndroidDriver driver;

    @RegisterExtension
    final AppiumTestExtension appiumTestExtension = new AppiumTestExtension(() -> driver);

    @Test
    @Tag("local")
    void opensExampleComInAndroidChrome() {
        driver = DriverFactory.createAndroidBrowserDriver();

        driver.get(TestConfig.targetUrl());

        WebDriverWait wait = new WebDriverWait(driver, TestConfig.explicitWait());
        wait.until(ExpectedConditions.titleContains("Example"));

        assertTrue(driver.getTitle().contains("Example"), "Expected browser title to contain 'Example'");
    }
}

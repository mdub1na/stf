package ru.stf.appium.tests

import io.appium.java_client.AppiumBy
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.openqa.selenium.support.ui.WebDriverWait
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.CapturedDevice
import ru.stf.appium.stf.DeviceSelector
import ru.stf.appium.stf.StfClient
import ru.stf.appium.support.DriverFactory
import ru.stf.appium.support.withDriver

@Tag("device")
class DeviceSmokeTest {
  private val config = TestConfig()
  private val factory = DriverFactory(config)

  @Test
  @Tag("stf-capture")
  fun `reserves and releases an Android device`() = onStf("Android") { device ->
    assertFalse(device.serial.isBlank())
  }

  @Test
  @Tag("stf-android-settings")
  fun `opens Android Settings through STF and Appium Grid`() = onStf("Android") { device ->
    withDriver(config, "android-settings", { factory.android(device) }) { driver ->
      driver.activateApp(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
      WebDriverWait(driver, config.wait).until { it.pageSource.orEmpty().contains("com.android.settings") }
      assertTrue(driver.findElements(AppiumBy.className("android.widget.TextView")).isNotEmpty(), "Settings should expose native text elements")
      assertTrue(driver.getScreenshotAs(org.openqa.selenium.OutputType.BYTES).isNotEmpty(), "Settings screenshot should be available")
    }
  }

  @Test
  @Tag("stf-ios-settings")
  fun `opens iOS Settings through STF and Appium Grid`() = onStf("iOS") { device ->
    withDriver(config, "ios-settings", { factory.ios(device) }) { driver ->
      driver.activateApp(config.value("IOS_BUNDLE_ID", "com.apple.Preferences"))
      WebDriverWait(driver, config.wait).until {
        (driver.executeScript("mobile: activeAppInfo") as Map<*, *>)["bundleId"] == config.value("IOS_BUNDLE_ID", "com.apple.Preferences")
      }
      WebDriverWait(driver, config.wait).until { it.pageSource.orEmpty().contains("XCUIElementType") }
      assertTrue(driver.findElements(AppiumBy.className("XCUIElementTypeApplication")).isNotEmpty(), "Settings should expose a native application element")
      driver.executeScript("mobile: swipe", mapOf("direction" to "up"))
      driver.executeScript("mobile: swipe", mapOf("direction" to "down"))
      assertTrue(driver.getScreenshotAs(org.openqa.selenium.OutputType.BYTES).isNotEmpty(), "Settings screenshot should be available")
    }
  }

  @Test
  @Tag("stf-ios-demo")
  fun `shows an iOS test in the STF live screen`() = onStf("iOS") { device ->
    val cycles = config.positiveInt("STF_DEMO_CYCLES", 8)
    require(cycles <= 20) { "STF_DEMO_CYCLES must be at most 20 to keep the reservation bounded" }
    withDriver(config, "ios-demo", { factory.ios(device) }) { driver ->
      driver.activateApp("com.apple.Preferences")
      WebDriverWait(driver, config.wait).until {
        (driver.executeScript("mobile: activeAppInfo") as Map<*, *>)["bundleId"] == "com.apple.Preferences"
      }
      repeat(cycles) { cycle ->
        println("STF live demo: cycle ${cycle + 1}/$cycles")
        driver.executeScript("mobile: swipe", mapOf("direction" to "up"))
        Thread.sleep(4000)
        driver.executeScript("mobile: swipe", mapOf("direction" to "down"))
        Thread.sleep(4000)
      }
      assertTrue(driver.getScreenshotAs(org.openqa.selenium.OutputType.BYTES).isNotEmpty(), "Demo screenshot should be available")
    }
  }

  @Test
  @Tag("stf-chrome")
  fun `opens a web page in Android Chrome`() = onStf("Android") { device ->
    withDriver(config, "android-chrome", { factory.android(device, browser = true) }) { driver ->
      driver.get(config.value("TEST_TARGET_URL", "https://example.com"))
      val title = config.value("TEST_EXPECTED_TITLE", "Example")
      WebDriverWait(driver, config.wait).until { it.title.orEmpty().contains(title) }
      assertTrue(driver.title.orEmpty().contains(title))
    }
  }

  @Test
  @Tag("local-android")
  fun `opens Android Settings on an explicitly selected local device`() {
    val device = CapturedDevice(config.required("ANDROID_UDID"), "", "Android", "", "")
    withDriver(config, "local-android-settings", { factory.android(device) }) { driver ->
      driver.activateApp(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
      WebDriverWait(driver, config.wait).until { it.pageSource.orEmpty().contains("com.android.settings") }
    }
  }

  @Test
  @Tag("local-ios")
  fun `opens iOS Settings on an explicitly selected local device`() {
    val device = CapturedDevice(config.required("IOS_UDID"), "", "iOS", config.required("IOS_PLATFORM_VERSION"), "")
    withDriver(config, "local-ios-settings", { factory.ios(device) }) { driver ->
      driver.activateApp(config.value("IOS_BUNDLE_ID", "com.apple.Preferences"))
      WebDriverWait(driver, config.wait).until {
        (driver.executeScript("mobile: activeAppInfo") as Map<*, *>)["bundleId"] == config.value("IOS_BUNDLE_ID", "com.apple.Preferences")
      }
      WebDriverWait(driver, config.wait).until { it.pageSource.orEmpty().contains("XCUIElementType") }
    }
  }

  private fun onStf(platform: String, test: (CapturedDevice) -> Unit) {
    val allowedSerials = if (platform == "iOS") factory.iosDeviceSerials() else null
    if (platform == "iOS" && allowedSerials == null) {
      require(config.value("STF_SERIAL").isNotEmpty()) { "STF_SERIAL is required for a direct iOS node" }
    }
    val selector = DeviceSelector(platform, config.value("STF_SERIAL"),
      config.value(if (platform == "iOS") "STF_IOS_MODEL" else "STF_MODEL"), config.value("STF_PROVIDER"), allowedSerials)
    StfClient(config.stfUrl, config.token).capture(selector, config.leaseMillis, config.captureWait).use { reservation ->
      println("Running $platform test on model=${reservation.device.model}, provider=${reservation.device.provider}")
      test(reservation.device)
    }
  }
}

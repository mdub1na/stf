package ru.stf.appium.support

import com.fasterxml.jackson.databind.ObjectMapper
import io.appium.java_client.android.AndroidDriver
import io.appium.java_client.android.options.UiAutomator2Options
import io.appium.java_client.ios.IOSDriver
import io.appium.java_client.ios.options.XCUITestOptions
import org.openqa.selenium.Capabilities
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.CapturedDevice
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class DriverFactory(private val config: TestConfig) {
  fun androidOptions(device: CapturedDevice, browser: Boolean = false): UiAutomator2Options {
    require(device.platform.equals("Android", true)) { "Expected an Android device" }
    return UiAutomator2Options().apply {
      setUdid(device.serial)
      setDeviceName(config.value("ANDROID_DEVICE_NAME", "Android"))
      setNoReset(true)
      setNewCommandTimeout(Duration.ofSeconds(120))
      setSystemPort(config.positiveInt("APPIUM_SYSTEM_PORT", 8200))
      val host = config.remoteAdbHost(device.provider)
      if (host.isNotEmpty()) {
        setRemoteAdbHost(host)
        setAdbPort(config.positiveInt("APPIUM_ADB_PORT", 5037))
      }
      if (browser) {
        setCapability("browserName", config.value("ANDROID_BROWSER_NAME", "Chrome"))
      } else {
        setAppPackage(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
        setAppActivity(config.value("ANDROID_APP_ACTIVITY", ".Settings"))
        setAppWaitPackage(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
      }
    }
  }

  fun iosOptions(device: CapturedDevice): XCUITestOptions {
    require(device.platform.equals("iOS", true)) { "Expected an iOS device" }
    return XCUITestOptions().apply {
      setUdid(device.serial)
      setDeviceName(config.value("IOS_DEVICE_NAME", "iPhone"))
      setPlatformVersion(config.value("IOS_PLATFORM_VERSION", device.version).also {
        require(it.isNotEmpty()) { "IOS_PLATFORM_VERSION is required when STF has no iOS version" }
      })
      // Activate the app through WDA after connection; attaching needs no host-side USB app lookup.
      setCapability("appium:autoLaunch", false)
      setSkipLogCapture(true)
      setNoReset(true)
      setNewCommandTimeout(Duration.ofSeconds(120))
      config.value("IOS_WDA_URL").takeIf { it.isNotEmpty() }?.let { setWebDriverAgentUrl(TestConfig.httpUri(it).toString()) }
      setCapability("appium:shouldTerminateApp", false)
    }
  }

  fun android(device: CapturedDevice, browser: Boolean = false): AndroidDriver {
    val options = androidOptions(device, browser)
    ensureSlot(options)
    return AndroidDriver(config.appiumUrl.toURL(), options)
  }

  fun ios(device: CapturedDevice): IOSDriver {
    val options = iosOptions(device)
    ensureSlot(options)
    return IOSDriver(config.appiumUrl.toURL(), options)
  }

  private fun ensureSlot(options: Capabilities) {
    val request = HttpRequest.newBuilder(URI.create(config.appiumUrl.toString() + "/status"))
      .timeout(Duration.ofSeconds(15)).GET().build()
    val response = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
      .send(request, HttpResponse.BodyHandlers.ofString())
    check(response.statusCode() == 200) { "Appium status returned HTTP ${response.statusCode()}" }
    val value = ObjectMapper().readTree(response.body()).path("value")
    check(value.path("ready").asBoolean()) { "Appium server is not ready" }
    if (!value.has("nodes")) return
    val match = value.path("nodes").any { node ->
      node.path("availability").asText().equals("UP", true) && node.path("slots").any { slot ->
        val stereotype = slot.path("stereotype")
        stereotype.path("platformName").asText().equals(options.getCapability("platformName").toString(), true) &&
          listOf("appium:remoteAdbHost", "appium:udid").all { key ->
            !stereotype.has(key) || stereotype.path(key).asText() == options.getCapability(key)?.toString()
          }
      }
    }
    check(match) { "Grid has no UP node matching this device and platform; no test was skipped" }
  }
}

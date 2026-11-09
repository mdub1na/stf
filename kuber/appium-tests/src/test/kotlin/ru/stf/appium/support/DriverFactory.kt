package ru.stf.appium.support

import com.fasterxml.jackson.databind.ObjectMapper
import io.appium.java_client.AppiumClientConfig
import io.appium.java_client.android.AndroidDriver
import io.appium.java_client.android.options.UiAutomator2Options
import io.appium.java_client.ios.IOSDriver
import io.appium.java_client.ios.options.XCUITestOptions
import org.openqa.selenium.Capabilities
import org.openqa.selenium.remote.http.Filter
import org.openqa.selenium.remote.http.HttpHandler
import org.openqa.selenium.remote.http.HttpMethod
import ru.stf.appium.coordinator.CoordinatorReservation
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.CapturedDevice
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class DriverFactory(private val config: TestConfig, private val reservation: CoordinatorReservation? = null) {
  fun androidOptions(device: CapturedDevice, browser: Boolean = false): UiAutomator2Options {
    require(device.platform.equals("Android", true)) { "Expected an Android device" }
    return UiAutomator2Options().apply {
      setUdid(device.serial)
      setDeviceName(config.value("ANDROID_DEVICE_NAME", "Android"))
      setNoReset(true)
      setNewCommandTimeout(Duration.ofSeconds(config.positiveInt("APPIUM_NEW_COMMAND_TIMEOUT_SECONDS", 120).toLong()))
      if (reservation == null) {
        setSystemPort(config.positiveInt("APPIUM_SYSTEM_PORT", 8200))
        val host = config.remoteAdbHost(device.provider)
        if (host.isNotEmpty()) {
          setRemoteAdbHost(host)
          setAdbPort(config.positiveInt("APPIUM_ADB_PORT", 5037))
        }
      }
      if (browser) {
        setCapability("browserName", config.value("ANDROID_BROWSER_NAME", "Chrome"))
      } else {
        setAppPackage(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
        setAppActivity(config.value("ANDROID_APP_ACTIVITY", ".Settings"))
        setAppWaitPackage(config.value("ANDROID_APP_PACKAGE", "com.android.settings"))
      }
      applyLease(device) { key, value -> setCapability(key, value) }
    }
  }

  fun iosOptions(device: CapturedDevice): XCUITestOptions {
    require(device.platform.equals("iOS", true)) { "Expected an iOS device" }
    return XCUITestOptions().apply {
      setUdid(device.serial)
      setDeviceName(config.value("IOS_DEVICE_NAME", "iPhone"))
      setPlatformVersion((if (reservation == null) config.value("IOS_PLATFORM_VERSION", device.version) else device.version).also {
        require(it.isNotEmpty()) { "IOS_PLATFORM_VERSION is required when STF has no iOS version" }
      })
      // Activate the app through WDA after connection; attaching needs no host-side USB app lookup.
      setCapability("appium:autoLaunch", false)
      setSkipLogCapture(true)
      setNoReset(true)
      setNewCommandTimeout(Duration.ofSeconds(config.positiveInt("APPIUM_NEW_COMMAND_TIMEOUT_SECONDS", 120).toLong()))
      if (reservation == null) {
        config.value("IOS_WDA_URL").takeIf { it.isNotEmpty() }?.let { setWebDriverAgentUrl(TestConfig.httpUri(it).toString()) }
      }
      setCapability("appium:shouldTerminateApp", false)
      applyLease(device) { key, value -> setCapability(key, value) }
    }
  }

  fun android(device: CapturedDevice, browser: Boolean = false): AndroidDriver {
    val options = androidOptions(device, browser)
    reservation?.let { return AndroidDriver(coordinatorConfig(it), options) }
    ensureSlot(options)
    return AndroidDriver(config.appiumUrl.toURL(), options)
  }

  fun ios(device: CapturedDevice): IOSDriver {
    val options = iosOptions(device)
    reservation?.let { return IOSDriver(coordinatorConfig(it), options) }
    ensureSlot(options)
    return IOSDriver(config.appiumUrl.toURL(), options)
  }

  private fun applyLease(device: CapturedDevice, apply: (String, Any) -> Unit) {
    reservation?.let {
      it.checkHealthy()
      require(device.serial == it.lease.device.serial) { "Driver device differs from the coordinator lease" }
      it.lease.capabilities.forEach(apply)
    }
  }

  private fun coordinatorConfig(reservation: CoordinatorReservation): AppiumClientConfig = AppiumClientConfig.defaultConfig()
    .baseUri(reservation.lease.webdriverUrl)
    .connectionTimeout(Duration.ofSeconds(15))
    .readTimeout(Duration.ofSeconds(config.positiveInt("APPIUM_READ_TIMEOUT_SECONDS", 240).toLong()))
    .directConnect(false)
    .withFilter(Filter { next -> HttpHandler { request ->
      // Quit is still allowed after a heartbeat failure so server cleanup can start immediately.
      val quitting = request.method == HttpMethod.DELETE && request.uri.substringBefore('?').matches(Regex(".*/session/[^/]+/?"))
      if (!quitting) reservation.checkHealthy()
      request.setHeader("Authorization", "Bearer ${config.coordinatorToken}")
      next.execute(request)
    } })

  private fun status(): com.fasterxml.jackson.databind.JsonNode {
    val request = HttpRequest.newBuilder(URI.create(config.appiumUrl.toString() + "/status"))
      .timeout(Duration.ofSeconds(15)).GET().build()
    val response = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
      .send(request, HttpResponse.BodyHandlers.ofString())
    check(response.statusCode() == 200) { "Appium status returned HTTP ${response.statusCode()}" }
    val value = ObjectMapper().readTree(response.body()).path("value")
    check(value.path("ready").asBoolean()) { "Appium server is not ready" }
    return value
  }

  /** A device-bound relay must exist before a farm phone is reserved. */
  fun iosDeviceSerials(): Set<String>? {
    val value = status()
    if (!value.has("nodes")) return null
    val serials = value.path("nodes").filter { it.path("availability").asText().equals("UP", true) }
      .flatMap { it.path("slots").toList() }
      .map { it.path("stereotype") }
      .filter { it.path("platformName").asText().equals("iOS", true) }
      .map { it.path("appium:udid").asText() }.filter { it.isNotEmpty() }.toSet()
    check(serials.isNotEmpty()) { "Grid has no UP iOS relay with an explicit device UDID" }
    return serials
  }

  internal fun ensureSlot(options: Capabilities) {
    val value = status()
    if (!value.has("nodes")) return
    val requestedVersion = options.getCapability("appium:platformVersion")?.toString()
    val match = value.path("nodes").any { node ->
      node.path("availability").asText().equals("UP", true) && node.path("slots").any { slot ->
        val stereotype = slot.path("stereotype")
        stereotype.path("platformName").asText().equals(options.getCapability("platformName").toString(), true) &&
          (requestedVersion == null || stereotype.path("appium:platformVersion").asText() == requestedVersion) &&
          listOf("appium:remoteAdbHost", "appium:udid").all { key ->
            !stereotype.has(key) || stereotype.path(key).asText() == options.getCapability(key)?.toString()
          }
      }
    }
    check(match) { "Grid has no UP node matching this device, platform and OS version; no test was skipped" }
  }
}

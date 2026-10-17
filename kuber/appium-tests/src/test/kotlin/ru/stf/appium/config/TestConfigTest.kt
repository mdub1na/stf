package ru.stf.appium.config

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import ru.stf.appium.stf.CapturedDevice
import ru.stf.appium.support.DriverFactory

class TestConfigTest {
  @Test
  fun `normalizes STF API URLs without duplicating the prefix`() {
    assertEquals("https://example.com/api/v1", TestConfig.normalizeStfUrl("https://example.com/").toString())
    assertEquals("https://example.com/api/v1", TestConfig.normalizeStfUrl("https://example.com/api/v1/").toString())
  }

  @Test
  fun `rejects credentials in endpoint URLs and invalid port settings`() {
    assertThrows(IllegalArgumentException::class.java) { TestConfig.httpUri("https://secret@example.com") }
    assertThrows(IllegalArgumentException::class.java) { TestConfig(mapOf("APPIUM_SYSTEM_PORT" to "-1")).positiveInt("APPIUM_SYSTEM_PORT", 8200) }
  }

  @Test
  fun `routes Android capabilities to the captured provider and isolated system port`() {
    val options = DriverFactory(TestConfig(mapOf("APPIUM_SYSTEM_PORT" to "8207")))
      .androidOptions(CapturedDevice("android-id", "model", "Android", "16", "stf-provider-2"))
    assertEquals("adbd-2.stf.svc.cluster.local", options.getCapability("appium:remoteAdbHost"))
    assertEquals(8207, options.getCapability("appium:systemPort"))
    assertEquals("android-id", options.getCapability("appium:udid"))
  }

  @Test
  fun `unknown Android providers fail instead of using the wrong ADB pool`() {
    assertThrows(IllegalStateException::class.java) { TestConfig().remoteAdbHost("unknown") }
  }

  @Test
  fun `iOS attaches without host USB app lookup and uses the reported OS version`() {
    val options = DriverFactory(TestConfig(mapOf("IOS_WDA_URL" to "http://127.0.0.1:18100")))
      .iosOptions(CapturedDevice("ios-id", "model", "iOS", "26.7.1", "Linux iOS"))
    assertEquals("26.7.1", options.getCapability("appium:platformVersion"))
    assertEquals("http://127.0.0.1:18100", options.getCapability("appium:webDriverAgentUrl"))
    assertEquals(false, options.getCapability("appium:autoLaunch"))
    assertNull(options.getCapability("appium:bundleId"))
  }
}

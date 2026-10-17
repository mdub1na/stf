package ru.stf.appium.config

import java.net.URI
import java.nio.file.Path
import java.time.Duration

class TestConfig(private val environment: Map<String, String> = System.getenv()) {
  fun value(name: String, default: String = ""): String = environment[name]?.trim()?.takeIf { it.isNotEmpty() } ?: default
  fun required(name: String): String = value(name).also { require(it.isNotEmpty()) { "$name is required" } }
  fun positiveInt(name: String, default: Int): Int = value(name, default.toString()).let {
    requireNotNull(it.toIntOrNull()?.takeIf { n -> n > 0 }) { "$name must be a positive integer" }
  }

  val appiumUrl: URI get() = httpUri(value("APPIUM_SERVER_URL", "http://127.0.0.1:4723"))
  val stfUrl: URI get() = normalizeStfUrl(required("STF_BASE_URL"))
  val token: String get() = required("STF_TOKEN")
  val wait: Duration get() = Duration.ofSeconds(positiveInt("APPIUM_WAIT_SECONDS", 30).toLong())
  val artifactsDir: Path get() = Path.of(value("TEST_ARTIFACTS_DIR", "build/appium-artifacts"))
  val leaseMillis: Long get() = positiveInt("STF_TIMEOUT_SECONDS", 600).toLong() * 1000
  val captureWait: Duration get() = Duration.ofSeconds(positiveInt("STF_CAPTURE_WAIT_SECONDS", 30).toLong())

  fun remoteAdbHost(provider: String): String = value("APPIUM_REMOTE_ADB_HOST").ifEmpty {
    when (provider) {
      "stf-provider" -> "adbd.stf.svc.cluster.local"
      "stf-provider-2" -> "adbd-2.stf.svc.cluster.local"
      "" -> ""
      else -> error("Unknown Android provider '$provider'; configure APPIUM_REMOTE_ADB_HOST")
    }
  }

  companion object {
    fun httpUri(value: String): URI = URI.create(value.trimEnd('/')).also {
      require(it.scheme in setOf("http", "https") && !it.host.isNullOrBlank() && it.userInfo == null && it.query == null && it.fragment == null) {
        "Expected an HTTP(S) endpoint without credentials, query or fragment"
      }
    }
    fun normalizeStfUrl(value: String): URI {
      val base = httpUri(value).toString()
      return URI.create(if (base.endsWith("/api/v1")) base else "$base/api/v1")
    }
  }
}

package ru.stf.appium.stf

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import ru.stf.appium.config.TestConfig
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID

private val mapper = ObjectMapper()

private data class ReservationIdentity(
  val serial: String,
  val reservationId: String,
  val deviceChannel: String,
  val leaseId: String
)

data class CapturedDevice(
  val serial: String,
  val model: String,
  val platform: String,
  val version: String,
  val provider: String,
  val reservationId: String = "",
  val deviceChannel: String = "",
  val leaseId: String = ""
)

data class DeviceSelector(
  val platform: String,
  val serial: String = "",
  val model: String = "",
  val provider: String = "",
  val allowedSerials: Set<String>? = null
)

class StfRequestException(val status: Int, action: String) : IllegalStateException("STF $action failed: HTTP $status")

class StfReservation(val device: CapturedDevice, private val release: () -> Unit) : AutoCloseable {
  private var closed = false
  override fun close() {
    if (!closed) {
      release()
      closed = true
    }
  }
}

class StfClient(
  baseUrl: URI,
  private val token: String,
  private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
) {
  private val base = TestConfig.normalizeStfUrl(baseUrl.toString()).toString()

  fun capture(selector: DeviceSelector, timeoutMillis: Long = 600_000, wait: Duration = Duration.ofSeconds(30)): StfReservation {
    require(timeoutMillis in 1..Int.MAX_VALUE.toLong() && !wait.isNegative) { "Capture timeouts must be positive and fit the STF lease limit" }
    val deadline = System.nanoTime() + wait.toNanos()
    do {
      val candidates = request("GET", "/devices").path("devices").filter { device ->
        device.path("present").asBoolean() && device.path("ready").asBoolean() &&
          !device.path("using").asBoolean() && !device.path("claimed").asBoolean() &&
          (device.path("owner").isMissingNode || device.path("owner").isNull) &&
          device.path("platform").asText().equals(selector.platform, ignoreCase = true) &&
          (selector.serial.isEmpty() || device.path("serial").asText() == selector.serial) &&
          (selector.allowedSerials == null || device.path("serial").asText() in selector.allowedSerials) &&
          (selector.model.isEmpty() || device.path("model").asText() == selector.model) &&
          (selector.provider.isEmpty() || provider(device) == selector.provider)
      }
      for (candidate in candidates.sortedBy { it.path("serial").asText() }) {
        val device = CapturedDevice(
          candidate.path("serial").asText(), candidate.path("model").asText(),
          candidate.path("platform").asText(), candidate.path("version").asText(), provider(candidate)
        )
        check(device.serial.isNotEmpty()) { "STF returned a device without a serial" }
        try {
          val leaseId = UUID.randomUUID().toString()
          val acknowledged = request("POST", "/user/devices", mapOf(
            "serial" to device.serial, "timeout" to timeoutMillis, "leaseId" to leaseId
          ))
          val identity = ReservationIdentity(
            device.serial,
            acknowledged.path("owner").path("reservationId").takeIf { it.isTextual }?.asText().orEmpty(),
            acknowledged.path("deviceChannel").takeIf { it.isTextual }?.asText().orEmpty(), leaseId
          )
          check(acknowledged.path("leaseId").asText() == leaseId &&
            identity.reservationId.isNotBlank() && identity.deviceChannel.isNotBlank()) {
            "STF did not acknowledge the reservation identity; a lease-capable STF server is required"
          }
          val captured = device.copy(
            reservationId = identity.reservationId, deviceChannel = identity.deviceChannel, leaseId = identity.leaseId
          )
          return StfReservation(captured) { release(identity) }
        } catch (error: StfRequestException) {
          if (error.status != 403 && error.status != 409) throw error
        }
      }
      if (System.nanoTime() >= deadline) break
      Thread.sleep(minOf(1000, maxOf(1, (deadline - System.nanoTime()) / 1_000_000)))
    } while (true)
    error("No free ${selector.platform} device matches serial='${selector.serial}' model='${selector.model}' provider='${selector.provider}'")
  }

  private fun release(identity: ReservationIdentity) {
    val devicePath = "/user/devices/${URLEncoder.encode(identity.serial, StandardCharsets.UTF_8)}"
    val current = request("GET", devicePath).path("device")
    check(current.path("owner").path("reservationId").asText() == identity.reservationId &&
      current.path("channel").asText() == identity.deviceChannel &&
      current.path("automationLeaseId").asText() == identity.leaseId) {
      "STF reservation identity changed before release"
    }
    // The provider checks the unique lease again if ownership changes after this snapshot.
    val released = request("POST", "$devicePath/automation/release", mapOf("leaseId" to identity.leaseId))
    check(released.path("leaseId").asText() == identity.leaseId) { "STF did not acknowledge the released lease" }
    val owned = request("GET", "/user/devices").path("devices")
    check(owned.none { it.path("serial").asText() == identity.serial &&
      (it.path("automationLeaseId").asText() == identity.leaseId ||
        it.path("owner").path("reservationId").asText() == identity.reservationId) }) {
      "STF still reports the reservation as owned after release"
    }
  }

  private fun request(method: String, path: String, body: Any? = null): JsonNode {
    val builder = HttpRequest.newBuilder(URI.create(base + path))
      .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer $token")
      .header("Accept", "application/json")
    val publisher = if (body == null) HttpRequest.BodyPublishers.noBody() else {
      builder.header("Content-Type", "application/json")
      HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))
    }
    val response = http.send(builder.method(method, publisher).build(), HttpResponse.BodyHandlers.ofString())
    if (response.statusCode() !in 200..299) throw StfRequestException(response.statusCode(), "$method $path")
    val result = mapper.readTree(response.body())
    check(!result.has("success") || result.path("success").asBoolean()) { "STF $method $path returned success=false" }
    return result
  }

  private fun provider(device: JsonNode): String = device.path("provider").let {
    if (it.isTextual) it.asText() else it.path("name").asText()
  }
}

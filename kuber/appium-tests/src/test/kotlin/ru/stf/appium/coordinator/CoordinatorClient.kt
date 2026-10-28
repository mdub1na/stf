package ru.stf.appium.coordinator

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.CapturedDevice
import ru.stf.appium.stf.DeviceSelector
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private val mapper = ObjectMapper()

data class CoordinatorLease(
  val id: String,
  val state: String,
  val device: CapturedDevice,
  val expiresAt: Instant,
  val deadlineAt: Instant,
  val heartbeatIntervalSeconds: Long,
  val capabilities: Map<String, Any>,
  val webdriverUrl: URI
)

class CoordinatorRequestException(val status: Int, action: String) :
  IllegalStateException("Coordinator $action failed: HTTP $status")

class CoordinatorHeartbeatException(cause: Throwable) :
  IllegalStateException("Coordinator heartbeat failed; device commands are disabled", cause)

/** Keeps renewing while the test runs; a lost renewal must fail even an otherwise successful test. */
class CoordinatorReservation internal constructor(
  val lease: CoordinatorLease,
  private val client: CoordinatorClient,
  private val cleanupWait: Duration
) : AutoCloseable {
  private val failure = AtomicReference<Throwable?>()
  private val executor = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "coordinator-heartbeat").apply { isDaemon = true }
  }
  @Volatile private var closed = false
  @Volatile private var currentExpiry = lease.expiresAt

  init {
    executor.scheduleWithFixedDelay({
      if (closed) return@scheduleWithFixedDelay
      try {
        val renewed = client.renew(lease.id)
        check(renewed.state == "active") { "Lease is no longer active: ${renewed.state}" }
        currentExpiry = renewed.expiresAt
      } catch (error: Exception) {
        if (!closed) failure.compareAndSet(null, error)
        executor.shutdown()
      }
    }, lease.heartbeatIntervalSeconds, lease.heartbeatIntervalSeconds, TimeUnit.SECONDS)
  }

  fun checkHealthy() {
    failure.get()?.let { throw CoordinatorHeartbeatException(it) }
    check(!closed && Instant.now().isBefore(currentExpiry) && Instant.now().isBefore(lease.deadlineAt)) {
      "Coordinator lease is closed or expired"
    }
  }

  @Synchronized override fun close() {
    if (closed) return
    closed = true
    executor.shutdownNow()
    // A test interrupted by its caller must still attempt server-side cleanup.
    val interrupted = Thread.interrupted()
    var cleanupFailure: Throwable? = null
    try {
      client.release(lease.id, cleanupWait)
    } catch (error: Throwable) {
      cleanupFailure = error
    } finally {
      if (interrupted) Thread.currentThread().interrupt()
    }
    failure.get()?.let {
      val error = CoordinatorHeartbeatException(it)
      cleanupFailure?.let(error::addSuppressed)
      throw error
    }
    cleanupFailure?.let { throw it }
  }
}

class CoordinatorClient(
  baseUrl: URI,
  private val token: String,
  private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
  private val pollInterval: Duration = Duration.ofSeconds(1)
) {
  private val base = TestConfig.normalizeStfUrl(baseUrl.toString()).toString()

  fun acquire(
    selector: DeviceSelector,
    runId: String,
    queueWait: Duration,
    maxDuration: Duration,
    cleanupWait: Duration = Duration.ofSeconds(90)
  ): CoordinatorReservation {
    require(runId.isNotBlank() && !queueWait.isNegative && maxDuration.seconds > 0 && cleanupWait.seconds > 0)
    val queueNanos = queueWait.toNanos()
    val params = mutableMapOf<String, Any>(
      "runId" to runId, "platform" to selector.platform,
      "queueTimeoutSeconds" to maxOf(1, queueWait.seconds), "maxDurationSeconds" to maxDuration.seconds
    )
    listOf("serial" to selector.serial, "model" to selector.model, "provider" to selector.provider)
      .filter { it.second.isNotEmpty() }.forEach { (key, value) -> params[key] = value }
    val key = UUID.randomUUID().toString()
    var request = createRequest(params, key)
    val id = requiredText(request, "id")
    val deadline = System.nanoTime() + queueNanos
    try {
      while (true) {
        when (requiredText(request, "state")) {
          "allocated" -> {
            val leaseId = requiredText(request, "leaseId")
            val lease = getLease(leaseId)
            check(lease.state == "active") { "Allocated lease is not active: ${lease.state}" }
            return CoordinatorReservation(lease, this, cleanupWait)
          }
          "queued" -> Unit
          "cancelled", "failed", "expired" -> error("Coordinator request ended in state ${request.path("state").asText()}")
          else -> error("Unknown coordinator request state")
        }
        check(System.nanoTime() < deadline) { "Timed out waiting for a coordinator device" }
        pause(deadline)
        request = request("GET", "/requests/${segment(id)}").path("request")
      }
    } catch (error: Throwable) {
      val interrupted = Thread.interrupted()
      try {
        // Cancellation also closes an allocation that won the race with the local timeout.
        request("DELETE", "/requests/${segment(id)}")
      } catch (cleanup: Throwable) {
        error.addSuppressed(cleanup)
      } finally {
        if (interrupted) Thread.currentThread().interrupt()
      }
      throw error
    }
  }

  fun getLease(id: String): CoordinatorLease = parseLease(request("GET", "/leases/${segment(id)}").path("lease"))
  internal fun renew(id: String): CoordinatorLease = parseLease(request("POST", "/leases/${segment(id)}/renew", emptyMap<String, Any>()).path("lease"))

  internal fun release(id: String, wait: Duration) {
    val deadline = System.nanoTime() + wait.toNanos()
    var state = request("DELETE", "/leases/${segment(id)}").path("lease").path("state").asText()
    while (state !in setOf("released", "expired", "quarantined")) {
      check(state == "cleaning" || state == "active") { "Unknown coordinator cleanup state: $state" }
      check(System.nanoTime() < deadline) { "Coordinator cleanup is still pending; device must not be reused" }
      pause(deadline)
      state = request("GET", "/leases/${segment(id)}").path("lease").path("state").asText()
    }
    check(state != "quarantined") { "Coordinator quarantined the device after cleanup failed" }
  }

  private fun createRequest(params: Map<String, Any>, key: String): JsonNode {
    repeat(3) { attempt ->
      try {
        return request("POST", "/requests", params, key).path("request")
      } catch (error: IOException) {
        if (attempt == 2) throw error
      } catch (error: CoordinatorRequestException) {
        if (error.status < 500 || attempt == 2) throw error
      }
    }
    error("Coordinator request could not be created")
  }

  private fun parseLease(node: JsonNode): CoordinatorLease {
    val id = requiredText(node, "id")
    val endpoint = TestConfig.httpUri(requiredText(node, "webdriverUrl"))
    // Never forward the coordinator credential to an endpoint supplied on another origin or path.
    check(endpoint.toString() == "$base/leases/${segment(id)}/webdriver") { "Unexpected coordinator WebDriver endpoint" }
    val device = node.path("device")
    val capabilities = mapper.convertValue(node.path("capabilities"), object : TypeReference<Map<String, Any>>() {})
    val serial = requiredText(device, "serial")
    check(capabilities["appium:udid"] == serial) { "Coordinator capabilities do not match the leased device" }
    val interval = node.path("heartbeatIntervalSeconds").asLong()
    require(interval > 0) { "Coordinator heartbeat interval must be positive" }
    return CoordinatorLease(id, requiredText(node, "state"), CapturedDevice(serial, device.path("model").asText(),
      requiredText(device, "platform"), device.path("version").asText(), device.path("provider").asText()),
      Instant.parse(requiredText(node, "expiresAt")), Instant.parse(requiredText(node, "deadlineAt")), interval, capabilities, endpoint)
  }

  private fun request(method: String, path: String, body: Any? = null, key: String? = null): JsonNode {
    val builder = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(30))
      .header("Authorization", "Bearer $token").header("Accept", "application/json")
    key?.let { builder.header("Idempotency-Key", it) }
    val publisher = if (body == null) HttpRequest.BodyPublishers.noBody() else {
      builder.header("Content-Type", "application/json")
      HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))
    }
    val response = http.send(builder.method(method, publisher).build(), HttpResponse.BodyHandlers.ofString())
    if (response.statusCode() !in 200..299) throw CoordinatorRequestException(response.statusCode(), "$method $path")
    return mapper.readTree(response.body())
  }

  private fun pause(deadline: Long) = Thread.sleep(minOf(pollInterval.toMillis().coerceAtLeast(1),
    ((deadline - System.nanoTime()) / 1_000_000).coerceAtLeast(1)))
  private fun requiredText(node: JsonNode, key: String) = node.path(key).asText().also {
    check(it.isNotBlank()) { "Coordinator response has no $key" }
  }
  private fun segment(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)
}

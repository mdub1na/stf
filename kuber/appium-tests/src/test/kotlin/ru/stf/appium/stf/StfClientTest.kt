package ru.stf.appium.stf

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import java.net.InetSocketAddress
import java.net.URI
import java.time.Duration

class StfClientTest {
  @Test
  fun `selects the requested platform and releases ownership when the test fails`() = FakeStf().use { server ->
    server.devices = listOf(server.device("iphone", "iOS"), server.device("android", "Android"))
    val failure = IllegalStateException("assertion failed")
    val result = assertThrows(IllegalStateException::class.java) {
      server.client.capture(DeviceSelector("Android"), 42_000, Duration.ZERO).use { lease ->
        assertEquals("android", lease.device.serial)
        throw failure
      }
    }
    assertSame(failure, result)
    assertEquals(listOf("android"), server.claims)
    assertTrue(server.owned.isEmpty())
    assertEquals(42_000, server.lastTimeout)
    assertTrue(server.paths.all { it.startsWith("/api/v1/") })
    assertTrue(server.authorization.all { it == "Bearer test-token" })
  }

  @Test
  fun `never claims unavailable or already owned devices`() = FakeStf().use { server ->
    server.devices = listOf(
      server.device("offline").plus("present" to false),
      server.device("starting").plus("ready" to false),
      server.device("busy").plus("owner" to mapOf("email" to "someone@example.invalid")),
      server.device("claimed").plus("claimed" to true),
      server.device("using").plus("using" to true)
    )
    assertThrows(IllegalStateException::class.java) { server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO) }
    assertTrue(server.claims.isEmpty())
  }

  @Test
  fun `tries another candidate after a concurrent reservation wins`() = FakeStf().use { server ->
    server.devices = listOf(server.device("a"), server.device("b"))
    server.conflicts.add("a")
    server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO).use { assertEquals("b", it.device.serial) }
    assertEquals(listOf("a", "b"), server.claims)
    assertTrue(server.owned.isEmpty())
  }

  @Test
  fun `does not fall back to a different model or provider`() = FakeStf().use { server ->
    server.devices = listOf(server.device("a"), server.device("b").plus("provider" to "other"))
    assertThrows(IllegalStateException::class.java) {
      server.client.capture(DeviceSelector("Android", model = "missing"), wait = Duration.ZERO)
    }
    server.client.capture(DeviceSelector("Android", provider = "other"), wait = Duration.ZERO).use { assertEquals("b", it.device.serial) }
  }

  @Test
  fun `only captures phones with registered Grid relays`() = FakeStf().use { server ->
    server.devices = listOf(server.device("a-unsupported", "iOS"), server.device("b-supported", "iOS"))
    server.client.capture(DeviceSelector("iOS", allowedSerials = setOf("b-supported")), wait = Duration.ZERO).use {
      assertEquals("b-supported", it.device.serial)
    }
    assertEquals(listOf("b-supported"), server.claims)
  }

  @Test
  fun `release is idempotent after success`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    lease.close()
    lease.close()
    assertEquals(1, server.releaseCalls)
  }

  @Test
  fun `reports a release failure without hiding the test failure`() = FakeStf().use { server ->
    server.failRelease = true
    val failure = IllegalArgumentException("test failure")
    val result = assertThrows(IllegalArgumentException::class.java) {
      server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO).use { throw failure }
    }
    assertSame(failure, result)
    assertEquals(1, result.suppressed.size)
    assertTrue(result.suppressed.single() is StfRequestException)
  }

  @Test
  fun `fails on invalid credentials without retrying another device`() = FakeStf().use { server ->
    server.claimStatus = 401
    val error = assertThrows(StfRequestException::class.java) {
      server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    }
    assertEquals(401, error.status)
    assertFalse(error.message.orEmpty().contains("test-token"))
    assertEquals(1, server.claims.size)
  }

  @Test
  fun `uses a fresh bounded lease and the acknowledged runtime instead of the discovery snapshot`() = FakeStf().use { server ->
    server.client.capture(DeviceSelector("Android"), 42_000, Duration.ZERO).use { reservation ->
      assertEquals(server.lastLeaseId, reservation.device.leaseId)
      assertEquals("reservation-1", reservation.device.reservationId)
      assertEquals("runtime:android", reservation.device.deviceChannel)
    }
    assertTrue(server.lastLeaseId.matches(Regex("[a-f0-9-]{36}")))
    assertEquals(server.lastLeaseId, server.lastReleaseLeaseId)
    assertEquals(42_000, server.lastTimeout)
    assertTrue(server.paths.contains("/api/v1/user/devices/android/automation/release"))
    assertFalse(server.methods.contains("DELETE"))
    assertFalse(server.paths.any { it.endsWith("/renew") })
  }

  @Test
  fun `generates a new lease UUID for each capture by the same account`() = FakeStf().use { server ->
    val first = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val firstId = first.device.leaseId
    first.close()
    val second = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val secondId = second.device.leaseId
    assertNotEquals(firstId, secondId)
    assertEquals(4, java.util.UUID.fromString(firstId).version())
    assertEquals(4, java.util.UUID.fromString(secondId).version())
    second.close()
    assertEquals(2, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `does not release a newer reservation belonging to the same account`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val replacement = server.replacement()
    server.owned["android"] = replacement
    assertThrows(IllegalStateException::class.java) { lease.close() }
    assertSame(replacement, server.owned["android"])
    assertEquals(0, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `refuses cleanup after the device runtime changes`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val original = server.owned.getValue("android")
    server.owned["android"] = original.copy(channel = "replacement-runtime")
    assertThrows(IllegalStateException::class.java) { lease.close() }
    assertEquals(0, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `fences a replacement that wins after the ownership lookup`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val replacement = server.replacement()
    server.replacementBeforeRelease = replacement
    val error = assertThrows(StfRequestException::class.java) { lease.close() }
    assertEquals(409, error.status)
    assertEquals(server.lastLeaseId, server.lastReleaseLeaseId)
    assertSame(replacement, server.owned["android"])
    assertEquals(1, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `does not mistake a new reservation for failed cleanup of the original lease`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    val replacement = server.replacement()
    server.replacementAfterRelease = replacement
    lease.close()
    lease.close()
    assertSame(replacement, server.owned["android"])
    assertEquals(1, server.releaseCalls)
  }

  @Test
  fun `fails closed when an older STF does not acknowledge reservation identity`() = FakeStf().use { server ->
    server.includeCaptureIdentity = false
    val error = assertThrows(IllegalStateException::class.java) {
      server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    }
    assertTrue(error.message.orEmpty().contains("lease-capable STF"))
    assertEquals(1, server.owned.size)
    assertEquals(0, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `rejects null or nontextual capture identity without releasing ownership`() {
    for (field in listOf("reservationId", "deviceChannel")) {
      FakeStf().use { server ->
        server.invalidCaptureField = field
        assertThrows(IllegalStateException::class.java) {
          server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
        }
        assertEquals(1, server.owned.size)
        assertEquals(0, server.releaseCalls)
        assertFalse(server.methods.contains("DELETE"))
      }
    }
  }

  @Test
  fun `rejects a capture acknowledgment for a different lease`() = FakeStf().use { server ->
    server.captureLeaseOverride = "previous-lease"
    assertThrows(IllegalStateException::class.java) {
      server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    }
    assertEquals(0, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `reports a provider that acknowledged release without clearing the original reservation`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    server.retainOwnershipAfterRelease = true
    val error = assertThrows(IllegalStateException::class.java) { lease.close() }
    assertTrue(error.message.orEmpty().contains("still reports the reservation"))
    assertEquals(1, server.releaseCalls)
    assertFalse(server.methods.contains("DELETE"))
  }

  @Test
  fun `does not fall back to legacy release when the fenced endpoint is unavailable`() = FakeStf().use { server ->
    val lease = server.client.capture(DeviceSelector("Android"), wait = Duration.ZERO)
    server.releaseStatus = 404
    val error = assertThrows(StfRequestException::class.java) { lease.close() }
    assertEquals(404, error.status)
    assertEquals(1, server.owned.size)
    assertFalse(server.methods.contains("DELETE"))
  }

  private class FakeStf : AutoCloseable {
    data class Ownership(val reservationId: String, val channel: String, val leaseId: String)

    private val mapper = ObjectMapper()
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    var devices = listOf(device("android"))
    val owned = mutableMapOf<String, Ownership>()
    val claims = mutableListOf<String>()
    val paths = mutableListOf<String>()
    val methods = mutableListOf<String>()
    val authorization = mutableListOf<String?>()
    val conflicts = mutableSetOf<String>()
    var lastTimeout = 0L
    var lastLeaseId = ""
    var lastReleaseLeaseId = ""
    var claimStatus = 200
    var failRelease = false
    var releaseStatus = 200
    var releaseCalls = 0
    var includeCaptureIdentity = true
    var invalidCaptureField: String? = null
    var captureLeaseOverride: String? = null
    var retainOwnershipAfterRelease = false
    var replacementBeforeRelease: Ownership? = null
    var replacementAfterRelease: Ownership? = null
    val client: StfClient

    init {
      server.createContext("/") { exchange ->
        val path = exchange.requestURI.path
        paths.add(path)
        methods.add(exchange.requestMethod)
        authorization.add(exchange.requestHeaders.getFirst("Authorization"))
        var status = 200
        val body: Any = when {
          exchange.requestMethod == "GET" && path == "/api/v1/devices" -> mapOf("success" to true, "devices" to devices)
          exchange.requestMethod == "GET" && path == "/api/v1/user/devices" -> mapOf(
            "success" to true, "devices" to owned.map { (serial, reservation) -> ownedDevice(serial, reservation) }
          )
          exchange.requestMethod == "POST" && path == "/api/v1/user/devices" -> {
            val request = mapper.readTree(exchange.requestBody)
            val serial = request.path("serial").asText()
            lastTimeout = request.path("timeout").asLong()
            lastLeaseId = request.path("leaseId").asText()
            claims.add(serial)
            status = if (serial in conflicts) 403 else claimStatus
            val response = mutableMapOf<String, Any?>("success" to (status == 200))
            if (status == 200) {
              val reservation = Ownership("reservation-${claims.size}", "runtime:$serial", lastLeaseId)
              owned[serial] = reservation
              if (includeCaptureIdentity) {
                response["owner"] = mapOf("email" to "runner@example.invalid", "reservationId" to reservation.reservationId)
                response["deviceChannel"] = reservation.channel
                response["leaseId"] = captureLeaseOverride ?: reservation.leaseId
                when (invalidCaptureField) {
                  "reservationId" -> response["owner"] = mapOf("reservationId" to null)
                  "deviceChannel" -> response["deviceChannel"] = 42
                }
              }
            }
            response
          }
          exchange.requestMethod == "GET" && path.startsWith("/api/v1/user/devices/") -> {
            val serial = path.substringAfterLast('/')
            val reservation = owned[serial]
            if (reservation == null) status = 403
            mapOf("success" to (status == 200), "device" to reservation?.let { ownedDevice(serial, it) })
          }
          exchange.requestMethod == "POST" && path.endsWith("/automation/release") -> {
            releaseCalls++
            val serial = path.removeSuffix("/automation/release").substringAfterLast('/')
            lastReleaseLeaseId = mapper.readTree(exchange.requestBody).path("leaseId").asText()
            replacementBeforeRelease?.let { owned[serial] = it }
            status = when {
              failRelease -> 500
              releaseStatus != 200 -> releaseStatus
              owned[serial]?.leaseId != lastReleaseLeaseId -> 409
              else -> 200
            }
            if (status == 200) {
              if (!retainOwnershipAfterRelease) owned.remove(serial)
              replacementAfterRelease?.let { owned[serial] = it }
            }
            mapOf("success" to (status == 200), "leaseId" to lastReleaseLeaseId)
          }
          else -> { status = 404; mapOf("success" to false) }
        }
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
      }
      server.start()
      client = StfClient(URI.create("http://127.0.0.1:${server.address.port}/api/v1/"), "test-token")
    }

    fun replacement() = Ownership("replacement-reservation", "runtime:android", "replacement-lease")

    fun device(serial: String, platform: String = "Android"): Map<String, Any?> = mapOf(
      "serial" to serial, "platform" to platform, "version" to "26.0", "model" to "test-model",
      "provider" to mapOf("name" to "test-provider"), "present" to true, "ready" to true,
      "channel" to "discovery:$serial", "owner" to null
    )

    private fun ownedDevice(serial: String, reservation: Ownership) = device(serial).plus(mapOf(
      "owner" to mapOf("email" to "runner@example.invalid", "reservationId" to reservation.reservationId),
      "channel" to reservation.channel, "automationLeaseId" to reservation.leaseId
    ))

    override fun close() = server.stop(0)
  }
}

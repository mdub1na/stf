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

  private class FakeStf : AutoCloseable {
    private val mapper = ObjectMapper()
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    var devices = listOf(device("android"))
    val owned = mutableSetOf<String>()
    val claims = mutableListOf<String>()
    val paths = mutableListOf<String>()
    val authorization = mutableListOf<String?>()
    val conflicts = mutableSetOf<String>()
    var lastTimeout = 0L
    var claimStatus = 200
    var failRelease = false
    var releaseCalls = 0
    val client: StfClient

    init {
      server.createContext("/") { exchange ->
        val path = exchange.requestURI.path
        paths.add(path)
        authorization.add(exchange.requestHeaders.getFirst("Authorization"))
        var status = 200
        val body: Any = when {
          exchange.requestMethod == "GET" && path == "/api/v1/devices" -> mapOf("success" to true, "devices" to devices)
          exchange.requestMethod == "GET" && path == "/api/v1/user/devices" -> mapOf("success" to true, "devices" to owned.map { mapOf("serial" to it) })
          exchange.requestMethod == "POST" && path == "/api/v1/user/devices" -> {
            val request = mapper.readTree(exchange.requestBody)
            val serial = request.path("serial").asText()
            lastTimeout = request.path("timeout").asLong()
            claims.add(serial)
            status = if (serial in conflicts) 403 else claimStatus
            if (status == 200) owned.add(serial)
            mapOf("success" to (status == 200))
          }
          exchange.requestMethod == "DELETE" -> {
            releaseCalls++
            if (failRelease) status = 500 else owned.remove(path.substringAfterLast('/'))
            mapOf("success" to !failRelease)
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

    fun device(serial: String, platform: String = "Android"): Map<String, Any?> = mapOf(
      "serial" to serial, "platform" to platform, "version" to "26.0", "model" to "test-model",
      "provider" to mapOf("name" to "test-provider"), "present" to true, "ready" to true, "owner" to null
    )

    override fun close() = server.stop(0)
  }
}

package ru.stf.appium.coordinator

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.DeviceSelector
import ru.stf.appium.support.DriverFactory
import ru.stf.appium.support.withDriver
import java.net.InetSocketAddress
import java.net.URI
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CoordinatorClientTest {
  @Test
  fun `retries request creation with one idempotency key and polls allocation and cleanup`() = FakeCoordinator().use { server ->
    server.failFirstCreate = true
    server.queuedPolls = 1
    server.client.acquire(DeviceSelector("Android", model = "test-model", provider = "pool"), "build-42",
      Duration.ofSeconds(2), Duration.ofHours(6)).use { reservation ->
      assertEquals("test-device", reservation.lease.device.serial)
      reservation.checkHealthy()
    }
    assertEquals(2, server.keys.size)
    assertEquals(1, server.keys.toSet().size)
    assertTrue(server.keys.all { it.isNotBlank() })
    assertEquals(21_600, server.createBody.path("maxDurationSeconds").asInt())
    assertEquals("build-42", server.createBody.path("runId").asText())
    assertEquals("test-model", server.createBody.path("model").asText())
    assertEquals("pool", server.createBody.path("provider").asText())
    assertTrue(server.events.count { it == "poll-request" } >= 2)
    assertEquals("released", server.state)
    assertTrue(server.apiAuth.all { it == "Bearer fake-token" })
    assertNull(server.handlerFailure)
  }

  @Test
  fun `cancels a queued request when the local wait expires`() = FakeCoordinator().use { server ->
    server.queuedPolls = 1000
    val error = assertThrows(IllegalStateException::class.java) {
      server.client.acquire(DeviceSelector("Android"), "build", Duration.ofMillis(40), Duration.ofHours(1))
    }
    assertTrue(error.message.orEmpty().contains("Timed out"))
    assertEquals("cancel-request", server.events.last())
    assertFalse(server.events.contains("create-session"))
  }

  @Test
  fun `cancels an allocated request when its lease response cannot be consumed`() = FakeCoordinator().use { server ->
    server.endpointOverride = "https://other.example.invalid/api/v1/leases/lease-1/webdriver"
    assertThrows(IllegalStateException::class.java) { server.acquire() }
    assertEquals("cancel-request", server.events.last())
    assertTrue(server.gatewayAuth.isEmpty())
  }

  @Test
  fun `creates an authenticated Android session with authoritative ports then quits before release`() = FakeCoordinator().use { server ->
    server.acquire().use { reservation ->
      val factory = DriverFactory(server.config(mapOf("APPIUM_SYSTEM_PORT" to "9999", "APPIUM_REMOTE_ADB_HOST" to "wrong-host")), reservation)
      withDriver(server.config(), "coordinator-android", { factory.android(reservation.lease.device) }) { driver ->
        assertEquals("<Application/>", driver.pageSource)
      }
    }
    assertEquals(8207, server.sessionCaps.path("appium:systemPort").asInt())
    assertEquals("adb-pool", server.sessionCaps.path("appium:remoteAdbHost").asText())
    assertEquals("test-device", server.sessionCaps.path("appium:udid").asText())
    assertTrue(server.gatewayAuth.isNotEmpty())
    assertTrue(server.gatewayAuth.all { it == "Bearer fake-token" })
    assertTrue(server.events.indexOf("quit") < server.events.indexOf("release"))
    assertFalse(server.events.contains("status"), "The coordinator path must not query Grid directly")
    assertEquals("released", server.state)
    assertNull(server.handlerFailure)
  }

  @Test
  fun `creates an iOS session with leased OS and WDA rather than local overrides`() = FakeCoordinator().use { server ->
    server.platform = "iOS"
    server.acquire().use { reservation ->
      val factory = DriverFactory(server.config(mapOf("IOS_PLATFORM_VERSION" to "invalid", "IOS_WDA_URL" to "http://wrong-host")), reservation)
      withDriver(server.config(), "coordinator-ios", { factory.ios(reservation.lease.device) }) { driver ->
        assertEquals("<Application/>", driver.pageSource)
      }
    }
    assertEquals("27.0", server.sessionCaps.path("appium:platformVersion").asText())
    assertEquals("http://wda-adapter:18101", server.sessionCaps.path("appium:webDriverAgentUrl").asText())
    assertTrue(server.gatewayAuth.all { it == "Bearer fake-token" })
    assertFalse(server.events.contains("status"))
    assertNull(server.handlerFailure)
  }

  @Test
  fun `heartbeat loss blocks commands but still quits and releases the lease`() = FakeCoordinator().use { server ->
    server.failRenew = true
    val error = assertThrows(CoordinatorHeartbeatException::class.java) {
      server.acquire().use { reservation ->
        val factory = DriverFactory(server.config(), reservation)
        withDriver(server.config(), "heartbeat-loss", { factory.android(reservation.lease.device) }) { driver ->
          assertTrue(server.renewed.await(3, TimeUnit.SECONDS), "Heartbeat should be attempted")
          val deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos()
          while (runCatching { reservation.checkHealthy() }.isSuccess && System.nanoTime() < deadline) Thread.sleep(5)
          assertThrows(CoordinatorHeartbeatException::class.java) { reservation.checkHealthy() }
          assertThrows(RuntimeException::class.java) { driver.pageSource }
          assertThrows(RuntimeException::class.java) { driver.manage().deleteAllCookies() }
        }
      }
    }
    assertTrue(error.cause is CoordinatorRequestException)
    assertEquals(0, server.events.count { it == "source" || it == "cookies" }, "Only quit may leave the client after heartbeat loss")
    assertTrue(server.events.indexOf("quit") < server.events.indexOf("release"))
    assertEquals("released", server.state)
    assertTrue(server.renewBodies.all { it == "{}" })
  }

  @Test
  fun `continues renewals during the test and preserves the original assertion on quarantine`() = FakeCoordinator().use { server ->
    server.quarantine = true
    val assertion = IllegalArgumentException("test assertion")
    val error = assertThrows(IllegalArgumentException::class.java) {
      server.acquire().use { reservation ->
        assertTrue(server.renewed.await(3, TimeUnit.SECONDS))
        reservation.checkHealthy()
        throw assertion
      }
    }
    assertSame(assertion, error)
    assertTrue(error.suppressed.any { it.message.orEmpty().contains("quarantined") })
    assertEquals("quarantined", server.state)
  }

  @Test
  fun `a rejected API credential is not retried and never appears in the error`() = FakeCoordinator().use { server ->
    server.createStatus = 401
    val error = assertThrows(CoordinatorRequestException::class.java) { server.acquire() }
    assertEquals(401, error.status)
    assertEquals(1, server.keys.size)
    assertFalse(error.message.orEmpty().contains("fake-token"))
  }

  private class FakeCoordinator : AutoCloseable {
    private val mapper = ObjectMapper()
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val executor = Executors.newCachedThreadPool()
    val url: URI get() = URI.create("http://127.0.0.1:${server.address.port}")
    val client: CoordinatorClient
    val events = CopyOnWriteArrayList<String>()
    val keys = CopyOnWriteArrayList<String>()
    val apiAuth = CopyOnWriteArrayList<String?>()
    val gatewayAuth = CopyOnWriteArrayList<String?>()
    val renewBodies = CopyOnWriteArrayList<String>()
    val renewed = CountDownLatch(1)
    @Volatile var queuedPolls = 0
    @Volatile var createStatus = 202
    @Volatile var failFirstCreate = false
    @Volatile var failRenew = false
    @Volatile var quarantine = false
    @Volatile var platform = "Android"
    @Volatile var state = "active"
    @Volatile var endpointOverride: String? = null
    @Volatile var createBody: JsonNode = mapper.createObjectNode()
    @Volatile var sessionCaps: JsonNode = mapper.createObjectNode()
    @Volatile var handlerFailure: Throwable? = null

    init {
      server.executor = executor
      server.createContext("/") { exchange ->
        val path = exchange.requestURI.path
        val method = exchange.requestMethod
        val rawBody = exchange.requestBody.readAllBytes().toString(Charsets.UTF_8)
        var status = 200
        val gateway = path.contains("/webdriver/")
        (if (gateway) gatewayAuth else apiAuth).add(exchange.requestHeaders.getFirst("Authorization"))
        val body: Any = try {
          when {
            method == "POST" && path == "/api/v1/requests" -> {
              events.add("request")
              keys.add(exchange.requestHeaders.getFirst("Idempotency-Key") ?: "")
              createBody = mapper.readTree(rawBody)
              status = if (failFirstCreate && keys.size == 1) 503 else createStatus
              mapOf("request" to requestBody(if (queuedPolls > 0) "queued" else "allocated"))
            }
            method == "GET" && path == "/api/v1/requests/request-1" -> {
              events.add("poll-request")
              mapOf("request" to requestBody(if (queuedPolls-- > 0) "queued" else "allocated"))
            }
            method == "DELETE" && path == "/api/v1/requests/request-1" -> {
              events.add("cancel-request")
              mapOf("request" to requestBody("cancelled"))
            }
            method == "POST" && path.endsWith("/renew") -> {
              events.add("renew")
              renewBodies.add(rawBody)
              if (failRenew) status = 503
              renewed.countDown()
              mapOf("lease" to leaseBody())
            }
            method == "DELETE" && path == "/api/v1/leases/lease-1" -> {
              events.add("release")
              state = "cleaning"
              mapOf("lease" to leaseBody())
            }
            method == "GET" && path == "/api/v1/leases/lease-1" -> {
              events.add("get-lease")
              if (state == "cleaning") state = if (quarantine) "quarantined" else "released"
              mapOf("lease" to leaseBody())
            }
            method == "POST" && path.endsWith("/webdriver/session") -> {
              events.add("create-session")
              val caps = mapper.readTree(rawBody).path("capabilities")
              val merged = mapper.createObjectNode()
              caps.path("alwaysMatch").properties().forEach { merged.set<JsonNode>(it.key, it.value) }
              caps.path("firstMatch").path(0).properties().forEach { merged.set<JsonNode>(it.key, it.value) }
              sessionCaps = merged
              mapOf("value" to mapOf("sessionId" to "session-1", "capabilities" to mapOf("platformName" to platform)))
            }
            method == "DELETE" && path.endsWith("/session/session-1") -> {
              events.add("quit")
              mapOf("value" to null)
            }
            path.endsWith("/source") -> {
              events.add("source")
              mapOf("value" to "<Application/>")
            }
            path.endsWith("/cookie") -> { events.add("cookies"); mapOf("value" to null) }
            path.endsWith("/screenshot") -> mapOf("value" to "aW1hZ2U=")
            path.endsWith("/status") -> { events.add("status"); mapOf("value" to mapOf("ready" to true)) }
            else -> { status = 404; mapOf("error" to "unexpected endpoint") }
          }
        } catch (error: Throwable) {
          handlerFailure = error
          status = 500
          mapOf("error" to "fake handler failed")
        }
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
      }
      server.start()
      client = CoordinatorClient(url, "fake-token", pollInterval = Duration.ofMillis(10))
    }

    fun config(overrides: Map<String, String> = emptyMap()) = TestConfig(mapOf(
      "COORDINATOR_URL" to url.toString(), "COORDINATOR_TOKEN" to "fake-token"
    ) + overrides)

    fun acquire() = client.acquire(DeviceSelector(platform), "test-run", Duration.ofSeconds(2), Duration.ofHours(6))

    private fun requestBody(state: String): Map<String, Any> = mapOf("id" to "request-1", "state" to state, "leaseId" to "lease-1")

    private fun leaseBody(): Map<String, Any> = mapOf(
      "id" to "lease-1", "state" to state,
      "device" to mapOf("serial" to "test-device", "platform" to platform, "version" to "27.0", "model" to "test-model", "provider" to "unknown-provider"),
      "expiresAt" to Instant.now().plusSeconds(60).toString(), "deadlineAt" to Instant.now().plusSeconds(21_600).toString(),
      "heartbeatIntervalSeconds" to 1,
      "capabilities" to (if (platform == "Android") mapOf("platformName" to platform, "appium:udid" to "test-device",
        "appium:systemPort" to 8207, "appium:remoteAdbHost" to "adb-pool", "appium:adbPort" to 5037)
        else mapOf("platformName" to platform, "appium:udid" to "test-device", "appium:platformVersion" to "27.0",
          "appium:webDriverAgentUrl" to "http://wda-adapter:18101")),
      "webdriverUrl" to (endpointOverride ?: "$url/api/v1/leases/lease-1/webdriver")
    )

    override fun close() {
      server.stop(0)
      executor.shutdownNow()
    }
  }
}

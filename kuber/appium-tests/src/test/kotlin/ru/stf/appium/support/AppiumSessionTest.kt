package ru.stf.appium.support

import com.sun.net.httpserver.HttpServer
import io.appium.java_client.AppiumDriver
import io.appium.java_client.android.options.UiAutomator2Options
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import ru.stf.appium.config.TestConfig
import ru.stf.appium.stf.CapturedDevice
import ru.stf.appium.stf.StfReservation
import java.net.InetSocketAddress
import java.net.URI
import java.nio.file.Files

class AppiumSessionTest {
  @Test
  fun `collects evidence and quits before releasing the STF device`() = FakeAppium().use { server ->
    val failure = IllegalArgumentException("assertion failed")
    val reservation = StfReservation(CapturedDevice("test", "model", "Android", "16", "")) { server.events.add("release") }
    val actual = assertThrows(IllegalArgumentException::class.java) {
      reservation.use {
        withDriver(server.config, "failure", server::driver) { throw failure }
      }
    }
    assertSame(failure, actual)
    assertEquals(listOf("create", "source", "screenshot", "quit", "release"), server.events)
  }

  @Test
  fun `still attempts screenshot when source collection fails`() = FakeAppium().use { server ->
    server.failSource = true
    val actual = assertThrows(IllegalArgumentException::class.java) {
      withDriver(server.config, "failure", server::driver) { throw IllegalArgumentException("assertion failed") }
    }
    assertEquals(1, actual.suppressed.size)
    assertTrue(server.events.contains("screenshot"))
    assertEquals("quit", server.events.last())
  }

  @Test
  fun `a quit failure does not replace the original test failure`() = FakeAppium().use { server ->
    server.failQuit = true
    val actual = assertThrows(IllegalArgumentException::class.java) {
      withDriver(server.config, "failure", server::driver) { throw IllegalArgumentException("assertion failed") }
    }
    assertEquals("assertion failed", actual.message)
    assertEquals(1, actual.suppressed.size)
  }

  private class FakeAppium : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val artifacts = Files.createTempDirectory("appium-artifact-test-")
    val config = TestConfig(mapOf("TEST_ARTIFACTS_DIR" to artifacts.toString()))
    val events = mutableListOf<String>()
    var failSource = false
    var failQuit = false

    init {
      server.createContext("/") { exchange ->
        val path = exchange.requestURI.path
        var status = 200
        val body = when {
          path == "/session" -> {
            events.add("create")
            """{"value":{"sessionId":"test-session","capabilities":{"platformName":"Android"}}}"""
          }
          path.endsWith("/source") -> {
            events.add("source")
            if (failSource) { status = 500; """{"value":{"error":"unknown error","message":"source failed"}}""" }
            else """{"value":"<Application/>"}"""
          }
          path.endsWith("/screenshot") -> { events.add("screenshot"); """{"value":"aW1hZ2U="}""" }
          exchange.requestMethod == "DELETE" -> {
            events.add("quit")
            if (failQuit) { status = 500; """{"value":{"error":"unknown error","message":"quit failed"}}""" }
            else """{"value":null}"""
          }
          else -> """{"value":null}"""
        }
        val bytes = body.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
      }
      server.start()
    }

    fun driver() = AppiumDriver(URI.create("http://127.0.0.1:${server.address.port}").toURL(), UiAutomator2Options())
    override fun close() {
      server.stop(0)
      artifacts.toFile().deleteRecursively()
    }
  }
}

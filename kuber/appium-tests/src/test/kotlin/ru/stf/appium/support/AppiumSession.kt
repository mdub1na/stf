package ru.stf.appium.support

import io.appium.java_client.AppiumDriver
import org.openqa.selenium.OutputType
import ru.stf.appium.config.TestConfig
import java.nio.file.Files
import java.time.Instant

/** Failure evidence must be collected before quit and before the STF reservation is released. */
fun <D : AppiumDriver> withDriver(config: TestConfig, name: String, create: () -> D, test: (D) -> Unit) {
  var driver: D? = null
  var failure: Throwable? = null
  try {
    driver = create()
    test(driver)
  } catch (error: Throwable) {
    failure = error
    driver?.let { saveArtifacts(config, name, it, error) }
    throw error
  } finally {
    try {
      driver?.quit()
    } catch (cleanup: Throwable) {
      if (failure != null) failure.addSuppressed(cleanup) else throw cleanup
    }
  }
}

private fun saveArtifacts(config: TestConfig, name: String, driver: AppiumDriver, failure: Throwable) {
  val directory = config.artifactsDir.resolve(name.replace(Regex("[^A-Za-z0-9_.-]"), "_") + "-" + Instant.now().toEpochMilli())
  try {
    Files.createDirectories(directory)
  } catch (error: Exception) {
    failure.addSuppressed(error)
    return
  }
  // One unavailable artifact must not prevent collecting the other.
  try {
    Files.writeString(directory.resolve("page-source.xml"), driver.pageSource)
  } catch (error: Exception) {
    failure.addSuppressed(error)
  }
  try {
    Files.write(directory.resolve("screenshot.png"), driver.getScreenshotAs(OutputType.BYTES))
  } catch (error: Exception) {
    failure.addSuppressed(error)
  }
}

plugins {
  kotlin("jvm") version "2.4.20"
}

group = "ru.stf"
version = "0.1.0-SNAPSHOT"

providers.gradleProperty("appiumWorkerId").orNull?.let { workerId ->
  require(workerId.matches(Regex("[A-Za-z0-9_-]+"))) { "appiumWorkerId contains invalid characters" }
  layout.buildDirectory.set(layout.projectDirectory.dir("build/workers/$workerId"))
}

kotlin {
  compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
}

dependencies {
  testImplementation("io.appium:java-client:10.0.0")
  testImplementation("com.fasterxml.jackson.core:jackson-databind:2.20.1")
  testImplementation("org.junit.jupiter:junit-jupiter:5.14.4")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach { options.release.set(17) }
tasks.withType<Test>().configureEach {
  useJUnitPlatform()
  testClassesDirs = sourceSets.test.get().output.classesDirs
  classpath = sourceSets.test.get().runtimeClasspath
  outputs.upToDateWhen { false }
  maxParallelForks = 1
  testLogging {
    events("passed", "skipped", "failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    showStandardStreams = true
  }
}

tasks.named<Test>("test") {
  description = "Runs device-free regression tests."
  useJUnitPlatform { excludeTags("device") }
}

mapOf(
  "localAndroidTest" to "local-android",
  "localIosTest" to "local-ios",
  "stfAndroidTest" to "stf-capture",
  "stfAppiumAndroidTest" to "stf-chrome",
  "stfAppiumSettingsTest" to "stf-android-settings",
  "stfAppiumIosSettingsTest" to "stf-ios-settings",
  "stfAppiumIosDemo" to "stf-ios-demo",
  "stfAppiumAndroidDemo" to "stf-android-demo"
).forEach { (taskName, tag) ->
  tasks.register<Test>(taskName) {
    description = "Runs the $tag smoke test; missing infrastructure fails the task."
    group = "verification"
    useJUnitPlatform { includeTags(tag) }
  }
}

// Run these tasks in independent CI workers; the coordinator serializes device allocation.
mapOf(
  "coordinatorAndroidTest" to "stf-android-settings",
  "coordinatorIosTest" to "stf-ios-settings",
  "coordinatorAndroidDemo" to "stf-android-demo",
  "coordinatorIosDemo" to "stf-ios-demo"
).forEach { (taskName, tag) ->
  tasks.register<Test>(taskName) {
    description = "Runs the $tag test through the coordinator; no direct STF fallback."
    group = "verification"
    useJUnitPlatform { includeTags(tag) }
    doFirst {
      require(!System.getenv("COORDINATOR_URL").isNullOrBlank()) { "COORDINATOR_URL is required" }
      require(!System.getenv("COORDINATOR_TOKEN").isNullOrBlank()) { "COORDINATOR_TOKEN is required" }
    }
  }
}

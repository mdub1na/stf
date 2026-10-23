plugins {
  kotlin("jvm") version "2.4.20"
}

group = "ru.stf"
version = "0.1.0-SNAPSHOT"

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

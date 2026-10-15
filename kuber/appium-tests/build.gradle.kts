plugins {
    java
}

group = "ru.stf"
version = "0.1.0-SNAPSHOT"

dependencies {
    testImplementation("io.appium:java-client:10.0.0")
    testImplementation("com.fasterxml.jackson.core:jackson-databind:2.20.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.14.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()

    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    outputs.upToDateWhen { false }

    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

tasks.named<Test>("test") {
    description = "Runs unit-style tests only. Device smoke tests must be started explicitly."

    useJUnitPlatform {
        excludeTags("local", "stf")
    }
}

tasks.register<Test>("localAndroidTest") {
    description = "Runs Android Appium tests against a locally connected Android device."
    group = "verification"

    useJUnitPlatform {
        includeTags("local")
    }
}

tasks.register<Test>("stfAndroidTest") {
    description = "Runs STF capture/free smoke tests."
    group = "verification"

    useJUnitPlatform {
        includeTags("stf")
    }
}

tasks.register<Test>("stfAppiumAndroidTest") {
    description = "Runs Android Appium tests against a STF-managed device."
    group = "verification"

    useJUnitPlatform {
        includeTags("stf-appium")
    }
}

tasks.register<Test>("stfAppiumSettingsTest") {
    description = "Runs Android Settings Appium smoke tests against a STF-managed device."
    group = "verification"

    useJUnitPlatform {
        includeTags("stf-appium-settings")
    }
}

tasks.register<Test>("stfAppiumIosSettingsTest") {
    description = "Runs iOS Settings Appium smoke tests against a STF-managed device."
    group = "verification"

    useJUnitPlatform {
        includeTags("stf-appium-ios-settings")
    }
}

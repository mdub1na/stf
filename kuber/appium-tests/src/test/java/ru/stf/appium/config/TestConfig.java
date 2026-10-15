package ru.stf.appium.config;

import java.net.MalformedURLException;
import java.net.URL;
import java.nio.file.Path;
import java.time.Duration;

public final class TestConfig {
    private static final String DEFAULT_APPIUM_SERVER_URL = "http://127.0.0.1:4723";
    private static final String DEFAULT_DEVICE_NAME = "Android";
    private static final String DEFAULT_IOS_DEVICE_NAME = "iPhone";
    private static final String DEFAULT_IOS_BUNDLE_ID = "com.apple.Preferences";
    private static final String DEFAULT_STF_IOS_MODEL = "iPhone (Альфа)";
    private static final String DEFAULT_BROWSER_NAME = "Chrome";
    private static final String DEFAULT_TARGET_URL = "https://example.com";
    private static final int DEFAULT_APPIUM_ADB_PORT = 5037;
    private static final int DEFAULT_APPIUM_SYSTEM_PORT = 0;
    private static final String DEFAULT_STF_DEVICE_TYPE = "";
    private static final String DEFAULT_STF_ADB_HOST = "adbd.stf.svc.cluster.local";
    private static final String DEFAULT_STF_ADB_HOST_2 = "adbd-2.stf.svc.cluster.local";
    private static final int DEFAULT_STF_AMOUNT = 1;
    private static final int DEFAULT_STF_TIMEOUT_SECONDS = 600;
    private static final Duration DEFAULT_EXPLICIT_WAIT = Duration.ofSeconds(20);
    private static final Duration DEFAULT_NEW_COMMAND_TIMEOUT = Duration.ofSeconds(120);

    private TestConfig() {
    }

    public static URL appiumServerUrl() {
        try {
            return new URL(env("APPIUM_SERVER_URL", DEFAULT_APPIUM_SERVER_URL));
        }
        catch (MalformedURLException err) {
            throw new IllegalArgumentException("APPIUM_SERVER_URL is not a valid URL", err);
        }
    }

    public static String deviceName() {
        return env("ANDROID_DEVICE_NAME", DEFAULT_DEVICE_NAME);
    }

    public static String iosDeviceName() {
        return env("IOS_DEVICE_NAME", DEFAULT_IOS_DEVICE_NAME);
    }

    public static String iosBundleId() {
        return env("IOS_BUNDLE_ID", DEFAULT_IOS_BUNDLE_ID);
    }

    public static String iosPlatformVersion() {
        return env("IOS_PLATFORM_VERSION", "");
    }

    public static String browserName() {
        return env("ANDROID_BROWSER_NAME", DEFAULT_BROWSER_NAME);
    }

    public static String targetUrl() {
        return env("TEST_TARGET_URL", DEFAULT_TARGET_URL);
    }

    public static String udid() {
        return env("ANDROID_UDID", "");
    }

    public static String iosUdid() {
        return env("IOS_UDID", "");
    }

    public static String appiumRemoteAdbHost() {
        return env("APPIUM_REMOTE_ADB_HOST", "");
    }

    public static String appiumRemoteAdbHost(String providerName) {
        String explicitRemoteAdbHost = appiumRemoteAdbHost();
        if (!explicitRemoteAdbHost.isBlank()) {
            return explicitRemoteAdbHost;
        }

        return switch (providerName) {
            case "stf-provider" -> DEFAULT_STF_ADB_HOST;
            case "stf-provider-2" -> DEFAULT_STF_ADB_HOST_2;
            default -> "";
        };
    }

    public static int appiumAdbPort() {
        return intEnv("APPIUM_ADB_PORT", DEFAULT_APPIUM_ADB_PORT);
    }

    public static int appiumSystemPort() {
        return intEnv("APPIUM_SYSTEM_PORT", DEFAULT_APPIUM_SYSTEM_PORT);
    }

    public static Duration explicitWait() {
        return DEFAULT_EXPLICIT_WAIT;
    }

    public static Duration newCommandTimeout() {
        return DEFAULT_NEW_COMMAND_TIMEOUT;
    }

    public static Path artifactsDir() {
        return Path.of(env("TEST_ARTIFACTS_DIR", "target/appium-artifacts"));
    }

    public static String stfBaseUrl() {
        String value = requiredEnv("STF_BASE_URL");
        if (value.endsWith("/api/v1")) {
            return value;
        }
        return value.replaceAll("/+$", "") + "/api/v1";
    }

    public static String stfToken() {
        return requiredEnv("STF_TOKEN");
    }

    public static int stfAmount() {
        return intEnv("STF_AMOUNT", DEFAULT_STF_AMOUNT);
    }

    public static int stfTimeoutSeconds() {
        return intEnv("STF_TIMEOUT_SECONDS", DEFAULT_STF_TIMEOUT_SECONDS);
    }

    public static boolean stfNeedAmount() {
        return booleanEnv("STF_NEED_AMOUNT", true);
    }

    public static String stfRunName() {
        return env("STF_RUN_NAME", "appium-local-capture-smoke-" + System.currentTimeMillis());
    }

    public static String stfDeviceType() {
        return env("STF_DEVICE_TYPE", DEFAULT_STF_DEVICE_TYPE);
    }

    public static String stfAbi() {
        return env("STF_ABI", "");
    }

    public static String stfModel() {
        return env("STF_MODEL", "");
    }

    public static String stfIosModel() {
        return env("STF_MODEL", env("STF_IOS_MODEL", DEFAULT_STF_IOS_MODEL));
    }

    public static String stfSdk() {
        return env("STF_SDK", "");
    }

    public static String stfVersion() {
        return env("STF_VERSION", "");
    }

    private static String env(String name, String defaultValue) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            return defaultValue;
        }
        return value;
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " environment variable is required");
        }
        return value;
    }

    private static int intEnv(String name, int defaultValue) {
        String value = env(name, "");
        if (value.isBlank()) {
            return defaultValue;
        }
        return Integer.parseInt(value);
    }

    private static boolean booleanEnv(String name, boolean defaultValue) {
        String value = env(name, "");
        if (value.isBlank()) {
            return defaultValue;
        }
        return Boolean.parseBoolean(value);
    }
}

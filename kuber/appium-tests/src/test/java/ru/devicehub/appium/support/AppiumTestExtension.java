package ru.devicehub.appium.support;

import io.appium.java_client.AppiumDriver;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.TestExecutionExceptionHandler;

import java.util.function.Supplier;

public final class AppiumTestExtension implements TestExecutionExceptionHandler, AfterEachCallback {
    private final Supplier<? extends AppiumDriver> driverSupplier;

    public AppiumTestExtension(Supplier<? extends AppiumDriver> driverSupplier) {
        this.driverSupplier = driverSupplier;
    }

    @Override
    public void handleTestExecutionException(ExtensionContext context, Throwable throwable) throws Throwable {
        TestArtifacts.saveFailureArtifacts(driverSupplier.get(), context.getDisplayName());
        throw throwable;
    }

    @Override
    public void afterEach(ExtensionContext context) {
        AppiumDriver driver = driverSupplier.get();
        if (driver != null) {
            driver.quit();
        }
    }
}

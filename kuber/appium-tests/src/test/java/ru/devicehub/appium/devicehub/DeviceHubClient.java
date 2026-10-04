package ru.devicehub.appium.devicehub;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public final class DeviceHubClient {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final HttpClient httpClient;
    private final String baseUrl;
    private final String token;

    public DeviceHubClient(String baseUrl, String token) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(20))
            .build();
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.token = token;
    }

    public CapturedDeviceGroup captureDevices(DeviceHubCaptureRequest captureRequest) {
        URI uri = URI.create(baseUrl + "/autotests?" + queryString(captureRequest));
        HttpRequest request = authorizedRequest(uri).GET().build();
        HttpResponse<String> response = send(request);
        assertSuccess(response, "capture DeviceHub devices");
        return parseCapturedGroup(response.body());
    }

    public void freeDevices(String groupId) {
        URI uri = URI.create(baseUrl + "/autotests?group=" + encode(groupId));
        HttpRequest request = authorizedRequest(uri).DELETE().build();
        HttpResponse<String> response = send(request);
        assertSuccess(response, "free DeviceHub devices");
    }

    private HttpRequest.Builder authorizedRequest(URI uri) {
        return HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(60))
            .header("Authorization", "Bearer " + token)
            .header("Accept", "application/json");
    }

    private HttpResponse<String> send(HttpRequest request) {
        try {
            return httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }
        catch (IOException err) {
            throw new IllegalStateException("DeviceHub request failed", err);
        }
        catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("DeviceHub request was interrupted", err);
        }
    }

    private void assertSuccess(HttpResponse<String> response, String action) {
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("Failed to " + action + ". HTTP " + response.statusCode() + ": " + response.body());
        }
    }

    private CapturedDeviceGroup parseCapturedGroup(String body) {
        try {
            JsonNode root = OBJECT_MAPPER.readTree(body);
            JsonNode group = root.path("group");
            if (group.isMissingNode() || group.isNull()) {
                throw new IllegalStateException("DeviceHub response does not contain group: " + body);
            }

            List<CapturedDevice> devices = new ArrayList<>();
            for (JsonNode device : group.path("devices")) {
                devices.add(new CapturedDevice(
                    text(device, "serial"),
                    text(device, "model"),
                    text(device, "platform"),
                    providerName(device),
                    text(device, "remoteConnectUrl")
                ));
            }

            return new CapturedDeviceGroup(
                text(group, "id"),
                text(group, "name"),
                devices
            );
        }
        catch (IOException err) {
            throw new IllegalStateException("Failed to parse DeviceHub response: " + body, err);
        }
    }

    private String queryString(DeviceHubCaptureRequest request) {
        List<String> params = new ArrayList<>();
        params.add(param("amount", request.amount()));
        params.add(param("timeout", request.timeoutSeconds()));
        params.add(param("need_amount", request.needAmount()));
        params.add(param("run", request.run()));
        addOptional(params, "type", request.type());
        addOptional(params, "abi", request.abi());
        addOptional(params, "model", request.model());
        addOptional(params, "sdk", request.sdk());
        addOptional(params, "version", request.version());
        return String.join("&", params);
    }

    private void addOptional(List<String> params, String name, String value) {
        if (value != null && !value.isBlank()) {
            params.add(param(name, value));
        }
    }

    private String param(String name, Object value) {
        return encode(name) + "=" + encode(String.valueOf(value));
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return "";
        }
        return value.asText();
    }

    private String providerName(JsonNode device) {
        JsonNode provider = device.path("provider");
        if (provider.isTextual()) {
            return provider.asText();
        }
        if (provider.isObject()) {
            return text(provider, "name");
        }
        return "";
    }
}

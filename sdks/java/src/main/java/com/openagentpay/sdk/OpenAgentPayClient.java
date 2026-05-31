/*
 * OpenAgentPay Java SDK — remote HTTP client
 * ==========================================
 *
 * The "client→proxy" half of the LiteLLM analogy. Point this at a running
 * oap-proxy / demo-api and call payments in one line — no in-process
 * wallet/protocol wiring. This is NOT a reimplementation of the engine; it's
 * the thin remote client, mirroring the TS @openagentpay/sdk.
 *
 * Dependency-light by design: HTTP via java.net.http (JDK built-in); JSON via
 * Jackson databind. No third-party networking deps.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Objects;

/**
 * Typed remote client for the OpenAgentPay REST surface. Construct via the
 * {@link #builder()}.
 *
 * <pre>{@code
 * OpenAgentPayClient client = OpenAgentPayClient.builder()
 *     .baseUrl("https://d1p7yxa99nxaye.cloudfront.net")
 *     .apiKey("oap_sk_...")            // optional
 *     .build();
 *
 * Models.SessionResponse s = client.createSession(
 *     new Models.CreateSessionRequest(5.0, 60));
 * Models.PayResponse p = client.pay(
 *     new Models.PayRequest(s.sessionId(), 0.5));
 * }</pre>
 */
public final class OpenAgentPayClient {

    private final String baseUrl;
    private final String apiKey; // nullable
    private final HttpClient httpClient;
    private final ObjectMapper mapper;

    private OpenAgentPayClient(Builder b) {
        Objects.requireNonNull(b.baseUrl, "OpenAgentPayClient: `baseUrl` is required");
        if (b.baseUrl.isEmpty()) {
            throw new IllegalArgumentException("OpenAgentPayClient: `baseUrl` is required");
        }
        // Normalize away any trailing slashes so we can safely concat paths.
        this.baseUrl = b.baseUrl.replaceAll("/+$", "");
        this.apiKey = b.apiKey;
        this.httpClient = b.httpClient != null
                ? b.httpClient
                : HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(30))
                        .build();
        this.mapper = JsonMapper.builder().build();
    }

    /** @return a new {@link Builder}. */
    public static Builder builder() {
        return new Builder();
    }

    // ========================================================================
    //  Public API — one method per REST route
    // ========================================================================

    /** POST /api/session — open a budgeted spending session. */
    public Models.SessionResponse createSession(Models.CreateSessionRequest input) {
        return request("POST", "/api/session", input, Models.SessionResponse.class);
    }

    /** POST /api/pay — execute a payment under an existing session. */
    public Models.PayResponse pay(Models.PayRequest input) {
        return request("POST", "/api/pay", input, Models.PayResponse.class);
    }

    /** GET /api/session/:id — fetch a session (throws on 404). */
    public Models.SessionResponse getSession(String id) {
        String path = "/api/session/" + urlEncodePathSegment(id);
        return request("GET", path, null, Models.SessionResponse.class);
    }

    /** GET /api/wallets — list available wallet providers + the default. */
    public Models.WalletsResponse listWallets() {
        return request("GET", "/api/wallets", null, Models.WalletsResponse.class);
    }

    /** GET /api/governance — current policy snapshot (server-defined shape). */
    public JsonNode getGovernance() {
        return request("GET", "/api/governance", null, JsonNode.class);
    }

    /** GET /api/governance/audit — recent audit events (server-defined shape). */
    public JsonNode getAudit() {
        return request("GET", "/api/governance/audit", null, JsonNode.class);
    }

    /**
     * Convenience: create a session and immediately pay under it. Returns both
     * the session and the payment so callers can keep paying on the same
     * session if they want. {@code expiryMinutes} defaults to 60 when null.
     */
    public Models.PayOnceResult payOnce(Models.PayOnceRequest input) {
        int expiry = input.expiryMinutes() != null ? input.expiryMinutes() : 60;
        Models.SessionResponse session = createSession(
                new Models.CreateSessionRequest(input.budgetUsd(), expiry));
        Models.PayResponse payment = pay(new Models.PayRequest(
                session.sessionId(),
                input.amountUsdc(),
                input.recipient(),
                input.walletProvider()));
        return new Models.PayOnceResult(session, payment);
    }

    // ========================================================================
    //  Internals
    // ========================================================================

    private <T> T request(String method, String path, Object body, Class<T> type) {
        boolean hasBody = body != null;
        HttpRequest.Builder rb = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(60))
                .header("accept", "application/json");

        if (apiKey != null && !apiKey.isEmpty()) {
            rb.header("authorization", "Bearer " + apiKey);
        }

        if (hasBody) {
            String json = serialize(body);
            rb.header("content-type", "application/json");
            rb.method(method, HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
        } else {
            rb.method(method, HttpRequest.BodyPublishers.noBody());
        }

        HttpResponse<String> res;
        try {
            res = httpClient.send(rb.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new OpenAgentPayApiException(0, "network_error",
                    "OpenAgentPay request failed: " + e.getMessage(), "");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OpenAgentPayApiException(0, "interrupted",
                    "OpenAgentPay request interrupted", "");
        }

        int status = res.statusCode();
        String rawBody = res.body() != null ? res.body() : "";

        if (status < 200 || status >= 300) {
            throw toApiError(status, rawBody);
        }
        return deserialize(rawBody, type);
    }

    private String serialize(Object body) {
        try {
            return mapper.writeValueAsString(body);
        } catch (Exception e) {
            throw new IllegalArgumentException("Failed to serialize request body: " + e.getMessage(), e);
        }
    }

    private <T> T deserialize(String raw, Class<T> type) {
        if (raw.isEmpty()) {
            throw new OpenAgentPayApiException(200, "empty_body",
                    "OpenAgentPay returned an empty body where JSON was expected", raw);
        }
        try {
            return mapper.readValue(raw, type);
        } catch (Exception e) {
            throw new OpenAgentPayApiException(200, "parse_error",
                    "Failed to parse OpenAgentPay response: " + e.getMessage(), raw);
        }
    }

    /**
     * Build a typed error from a non-2xx response, preferring a server-supplied
     * machine code. The server returns JSON like {@code {"error": "..."}} or
     * {@code {"message": "..."}}; we tolerate non-JSON bodies too.
     */
    private OpenAgentPayApiException toApiError(int status, String raw) {
        String message = "OpenAgentPay request failed with status " + status;
        String code = "http_" + status;

        JsonNode obj = null;
        if (!raw.isEmpty()) {
            try {
                JsonNode parsed = mapper.readTree(raw);
                if (parsed.isObject()) {
                    obj = parsed;
                }
            } catch (Exception ignored) {
                // Non-JSON body — fall back to using it as the message.
            }
        }

        if (obj != null) {
            JsonNode err = obj.get("error");
            JsonNode msg = obj.get("message");
            if (err != null && err.isTextual() && !err.asText().isEmpty()) {
                message = err.asText();
                code = err.asText();
            } else if (msg != null && msg.isTextual() && !msg.asText().isEmpty()) {
                message = msg.asText();
            }
            // Prefer an explicit machine code if the server supplied one.
            JsonNode explicit = obj.has("errorCode") ? obj.get("errorCode") : obj.get("code");
            if (explicit != null && explicit.isTextual() && !explicit.asText().isEmpty()) {
                code = explicit.asText();
            }
        } else if (!raw.isEmpty()) {
            message = raw;
        }

        return new OpenAgentPayApiException(status, code, message, raw);
    }

    /** Percent-encode a single path segment (encodeURIComponent equivalent for path use). */
    private static String urlEncodePathSegment(String s) {
        StringBuilder out = new StringBuilder();
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        for (byte bb : bytes) {
            int c = bb & 0xFF;
            boolean unreserved = (c >= 'A' && c <= 'Z')
                    || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~';
            if (unreserved) {
                out.append((char) c);
            } else {
                out.append('%');
                out.append(Character.toUpperCase(Character.forDigit((c >> 4) & 0xF, 16)));
                out.append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
            }
        }
        return out.toString();
    }

    // ========================================================================
    //  Builder
    // ========================================================================

    /** Fluent builder for {@link OpenAgentPayClient}. */
    public static final class Builder {
        private String baseUrl = "https://d1p7yxa99nxaye.cloudfront.net";
        private String apiKey;
        private HttpClient httpClient;

        private Builder() {
        }

        /** Base URL of the oap-proxy / demo-api. Trailing slashes are stripped. */
        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        /** Optional bearer token sent as {@code Authorization: Bearer <apiKey>}. */
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        /** Optional custom {@link HttpClient} (e.g. for tests or proxies). */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public OpenAgentPayClient build() {
            return new OpenAgentPayClient(this);
        }
    }
}

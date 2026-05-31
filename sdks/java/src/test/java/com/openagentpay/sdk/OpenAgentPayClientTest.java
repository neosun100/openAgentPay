/*
 * OpenAgentPay Java SDK — tests
 * =============================
 *
 * Network-free integration tests: we spin up a com.sun.net.httpserver.HttpServer
 * (JDK built-in) on an ephemeral port and point the real java.net.http client at
 * it. No external network access required.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenAgentPayClientTest {

    private HttpServer server;
    private String baseUrl;

    // Captured request facts for assertion in handlers.
    private final List<RecordedRequest> recorded = new ArrayList<>();

    record RecordedRequest(String method, String path, String authorization,
                           String contentType, String body) {
    }

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    // ------------------------------------------------------------------------
    //  Helpers
    // ------------------------------------------------------------------------

    /** Register a handler that records the request and replies with status + json. */
    private void stub(String path, int status, String json) {
        server.createContext(path, new HttpHandler() {
            @Override
            public void handle(HttpExchange ex) throws IOException {
                String body = readBody(ex.getRequestBody());
                recorded.add(new RecordedRequest(
                        ex.getRequestMethod(),
                        ex.getRequestURI().getPath(),
                        ex.getRequestHeaders().getFirst("Authorization"),
                        ex.getRequestHeaders().getFirst("Content-Type"),
                        body));
                byte[] out = json.getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(status, out.length);
                ex.getResponseBody().write(out);
                ex.close();
            }
        });
    }

    private static String readBody(InputStream in) throws IOException {
        return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }

    private OpenAgentPayClient client() {
        return OpenAgentPayClient.builder().baseUrl(baseUrl).build();
    }

    // ------------------------------------------------------------------------
    //  1. createSession
    // ------------------------------------------------------------------------

    @Test
    void createSessionReturnsSession() {
        stub("/api/session", 200, """
                {"sessionId":"sess_1","budgetUsd":5.0,"expiryMinutes":60,
                 "createdAt":"2026-05-30T00:00:00Z","expiresAt":"2026-05-30T01:00:00Z"}""");

        Models.SessionResponse s = client().createSession(
                new Models.CreateSessionRequest(5.0, 60));

        assertEquals("sess_1", s.sessionId());
        assertEquals(5.0, s.budgetUsd());
        assertEquals(60, s.expiryMinutes());
        assertEquals("2026-05-30T00:00:00Z", s.createdAt());
        assertEquals("2026-05-30T01:00:00Z", s.expiresAt());

        RecordedRequest rr = recorded.get(0);
        assertEquals("POST", rr.method());
        assertEquals("/api/session", rr.path());
        assertTrue(rr.contentType().contains("application/json"));
        assertTrue(rr.body().contains("\"budgetUsd\":5.0"));
        assertTrue(rr.body().contains("\"expiryMinutes\":60"));
    }

    // ------------------------------------------------------------------------
    //  2. pay (success) — full payload shape
    // ------------------------------------------------------------------------

    @Test
    void paySuccessParsesFullPayload() {
        stub("/api/pay", 200, """
                {"success":true,"txHash":"0xabc","explorerUrl":"https://scan/tx/0xabc",
                 "amountUsdc":0.5,"amountAtomic":"500000","payer":"0xPayer","recipient":"0xRecip",
                 "network":"hashkey-testnet","walletProvider":"hashkey",
                 "paymentPayload":{"chainId":133,"verifyingContract":"0xUSDC",
                   "authorization":{"from":"0xPayer","to":"0xRecip","value":"500000",
                     "validAfter":"0","validBefore":"99","nonce":"0xnonce"},
                   "signature":"0xsig","v":27,"r":"0xr","s":"0xs"}}""");

        Models.PayResponse p = client().pay(
                new Models.PayRequest("sess_1", 0.5, "0xRecip", "hashkey"));

        assertTrue(p.success());
        assertEquals("0xabc", p.txHash());
        assertEquals("https://scan/tx/0xabc", p.explorerUrl());
        assertEquals(0.5, p.amountUsdc());
        assertEquals("500000", p.amountAtomic());
        assertEquals("hashkey", p.walletProvider());
        assertNull(p.errorCode());

        assertNotNull(p.paymentPayload());
        assertEquals(133, p.paymentPayload().chainId());
        assertEquals(27, p.paymentPayload().v());
        assertEquals("0xnonce", p.paymentPayload().authorization().nonce());
        assertEquals("500000", p.paymentPayload().authorization().value());

        // recipient + walletProvider must be present in the request body.
        RecordedRequest rr = recorded.get(0);
        assertTrue(rr.body().contains("\"recipient\":\"0xRecip\""));
        assertTrue(rr.body().contains("\"walletProvider\":\"hashkey\""));
    }

    // ------------------------------------------------------------------------
    //  3. pay optional fields omitted from body when null
    // ------------------------------------------------------------------------

    @Test
    void payOmitsNullOptionalFields() {
        stub("/api/pay", 200, """
                {"success":true,"amountUsdc":1.0,"amountAtomic":"1000000",
                 "payer":"0xP","recipient":"0xR","network":"net","walletProvider":"hashkey",
                 "paymentPayload":{"chainId":1,"verifyingContract":"0xC",
                   "authorization":{"from":"0xP","to":"0xR","value":"1000000",
                     "validAfter":"0","validBefore":"1","nonce":"0xn"},
                   "signature":"0xs","v":28,"r":"0xr","s":"0xs"}}""");

        client().pay(new Models.PayRequest("sess_1", 1.0));

        RecordedRequest rr = recorded.get(0);
        assertFalse(rr.body().contains("recipient"));
        assertFalse(rr.body().contains("walletProvider"));
        assertTrue(rr.body().contains("\"sessionId\":\"sess_1\""));
    }

    // ------------------------------------------------------------------------
    //  4. pay error → typed exception with status + code + message + raw
    // ------------------------------------------------------------------------

    @Test
    void payErrorThrowsTypedException() {
        stub("/api/pay", 400, """
                {"error":"budget_exceeded","message":"Payment exceeds session budget","errorCode":"BUDGET_EXCEEDED"}""");

        OpenAgentPayApiException ex = assertThrows(OpenAgentPayApiException.class,
                () -> client().pay(new Models.PayRequest("sess_1", 999.0)));

        assertEquals(400, ex.status());
        assertEquals("BUDGET_EXCEEDED", ex.code()); // explicit errorCode wins
        assertEquals("budget_exceeded", ex.getMessage()); // error string used as message
        assertTrue(ex.raw().contains("budget_exceeded"));
    }

    // ------------------------------------------------------------------------
    //  5. error without explicit code falls back to http_<status>
    // ------------------------------------------------------------------------

    @Test
    void errorWithoutCodeFallsBackToHttpStatus() {
        stub("/api/pay", 500, """
                {"message":"internal boom"}""");

        OpenAgentPayApiException ex = assertThrows(OpenAgentPayApiException.class,
                () -> client().pay(new Models.PayRequest("sess_1", 1.0)));

        assertEquals(500, ex.status());
        assertEquals("http_500", ex.code());
        assertEquals("internal boom", ex.getMessage());
    }

    // ------------------------------------------------------------------------
    //  6. getSession 404 → exception
    // ------------------------------------------------------------------------

    @Test
    void getSessionNotFoundThrows() {
        stub("/api/session/", 404, """
                {"error":"session_not_found"}""");

        OpenAgentPayApiException ex = assertThrows(OpenAgentPayApiException.class,
                () -> client().getSession("missing"));

        assertEquals(404, ex.status());
        assertEquals("session_not_found", ex.code());

        RecordedRequest rr = recorded.get(0);
        assertEquals("GET", rr.method());
        assertEquals("/api/session/missing", rr.path());
    }

    // ------------------------------------------------------------------------
    //  7. getSession success
    // ------------------------------------------------------------------------

    @Test
    void getSessionReturnsSession() {
        stub("/api/session/", 200, """
                {"sessionId":"sess_42","budgetUsd":10.0,"expiryMinutes":30,
                 "createdAt":"2026-05-30T00:00:00Z","expiresAt":"2026-05-30T00:30:00Z"}""");

        Models.SessionResponse s = client().getSession("sess_42");
        assertEquals("sess_42", s.sessionId());
        assertEquals(10.0, s.budgetUsd());
        assertEquals(30, s.expiryMinutes());
    }

    // ------------------------------------------------------------------------
    //  8. listWallets
    // ------------------------------------------------------------------------

    @Test
    void listWalletsParsesArray() {
        stub("/api/wallets", 200, """
                {"wallets":[
                  {"walletProvider":"hashkey","displayName":"HashKey","chainName":"HashKey Testnet",
                   "chainId":133,"tokenLabel":"USDC","tokenAddress":"0xUSDC","agentAddress":"0xAgent"},
                  {"walletProvider":"circle","displayName":"Circle","chainName":"Base Sepolia",
                   "chainId":84532,"tokenLabel":"USDC","tokenAddress":"0xBaseUSDC","agentAddress":"0xAg2"}],
                 "defaultProvider":"hashkey"}""");

        Models.WalletsResponse w = client().listWallets();
        assertEquals("hashkey", w.defaultProvider());
        assertEquals(2, w.wallets().size());
        assertEquals("hashkey", w.wallets().get(0).walletProvider());
        assertEquals(133, w.wallets().get(0).chainId());
        assertEquals("Circle", w.wallets().get(1).displayName());
        assertEquals(84532, w.wallets().get(1).chainId());
    }

    // ------------------------------------------------------------------------
    //  9. getGovernance / getAudit return raw JsonNode
    // ------------------------------------------------------------------------

    @Test
    void getGovernanceAndAuditReturnJsonNode() {
        stub("/api/governance", 200, """
                {"policy":"strict","maxPerTxUsd":100,"limits":{"daily":1000}}""");
        stub("/api/governance/audit", 200, """
                {"events":[{"type":"pay","ok":true}]}""");

        JsonNode gov = client().getGovernance();
        assertEquals("strict", gov.get("policy").asText());
        assertEquals(100, gov.get("maxPerTxUsd").asInt());
        assertEquals(1000, gov.get("limits").get("daily").asInt());

        JsonNode audit = client().getAudit();
        assertTrue(audit.get("events").isArray());
        assertEquals("pay", audit.get("events").get(0).get("type").asText());
    }

    // ------------------------------------------------------------------------
    //  10. payOnce — creates session then pays (default expiry 60)
    // ------------------------------------------------------------------------

    @Test
    void payOnceCreatesSessionThenPays() {
        stub("/api/session", 200, """
                {"sessionId":"sess_once","budgetUsd":3.0,"expiryMinutes":60,
                 "createdAt":"2026-05-30T00:00:00Z","expiresAt":"2026-05-30T01:00:00Z"}""");
        stub("/api/pay", 200, """
                {"success":true,"txHash":"0xpayonce","amountUsdc":1.5,"amountAtomic":"1500000",
                 "payer":"0xP","recipient":"0xR","network":"net","walletProvider":"hashkey",
                 "paymentPayload":{"chainId":1,"verifyingContract":"0xC",
                   "authorization":{"from":"0xP","to":"0xR","value":"1500000",
                     "validAfter":"0","validBefore":"1","nonce":"0xn"},
                   "signature":"0xs","v":27,"r":"0xr","s":"0xs"}}""");

        Models.PayOnceResult res = client().payOnce(
                new Models.PayOnceRequest(3.0, 1.5));

        assertEquals("sess_once", res.session().sessionId());
        assertTrue(res.payment().success());
        assertEquals("0xpayonce", res.payment().txHash());

        // Two requests were issued: session, then pay. Default expiry 60.
        assertEquals(2, recorded.size());
        assertEquals("/api/session", recorded.get(0).path());
        assertTrue(recorded.get(0).body().contains("\"expiryMinutes\":60"));
        assertEquals("/api/pay", recorded.get(1).path());
        assertTrue(recorded.get(1).body().contains("\"sessionId\":\"sess_once\""));
    }

    // ------------------------------------------------------------------------
    //  11. payOnce honors explicit expiryMinutes + forwards recipient/wallet
    // ------------------------------------------------------------------------

    @Test
    void payOnceHonorsExplicitExpiryAndForwardsOptionals() {
        stub("/api/session", 200, """
                {"sessionId":"sess_e","budgetUsd":2.0,"expiryMinutes":15,
                 "createdAt":"a","expiresAt":"b"}""");
        stub("/api/pay", 200, """
                {"success":true,"amountUsdc":1.0,"amountAtomic":"1000000",
                 "payer":"0xP","recipient":"0xRecip","network":"net","walletProvider":"circle",
                 "paymentPayload":{"chainId":1,"verifyingContract":"0xC",
                   "authorization":{"from":"0xP","to":"0xRecip","value":"1000000",
                     "validAfter":"0","validBefore":"1","nonce":"0xn"},
                   "signature":"0xs","v":27,"r":"0xr","s":"0xs"}}""");

        client().payOnce(new Models.PayOnceRequest(2.0, 1.0, "0xRecip", "circle", 15));

        assertTrue(recorded.get(0).body().contains("\"expiryMinutes\":15"));
        assertTrue(recorded.get(1).body().contains("\"recipient\":\"0xRecip\""));
        assertTrue(recorded.get(1).body().contains("\"walletProvider\":\"circle\""));
    }

    // ------------------------------------------------------------------------
    //  12. apiKey → Authorization: Bearer header
    // ------------------------------------------------------------------------

    @Test
    void apiKeySendsBearerHeader() {
        stub("/api/wallets", 200, """
                {"wallets":[],"defaultProvider":"hashkey"}""");

        OpenAgentPayClient c = OpenAgentPayClient.builder()
                .baseUrl(baseUrl)
                .apiKey("oap_sk_test123")
                .build();
        c.listWallets();

        assertEquals("Bearer oap_sk_test123", recorded.get(0).authorization());
    }

    @Test
    void noApiKeyMeansNoAuthHeader() {
        stub("/api/wallets", 200, """
                {"wallets":[],"defaultProvider":"hashkey"}""");

        client().listWallets();
        assertNull(recorded.get(0).authorization());
    }

    // ------------------------------------------------------------------------
    //  13. trailing-slash baseUrl is normalized (no double slash)
    // ------------------------------------------------------------------------

    @Test
    void trailingSlashBaseUrlIsNormalized() {
        AtomicReference<String> seenPath = new AtomicReference<>();
        server.createContext("/api/wallets", ex -> {
            seenPath.set(ex.getRequestURI().getPath());
            byte[] out = "{\"wallets\":[],\"defaultProvider\":\"hashkey\"}"
                    .getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });

        OpenAgentPayClient c = OpenAgentPayClient.builder()
                .baseUrl(baseUrl + "///")
                .build();
        Models.WalletsResponse w = c.listWallets();

        assertNotNull(w);
        assertEquals("/api/wallets", seenPath.get()); // exactly one leading slash
    }

    // ------------------------------------------------------------------------
    //  14. non-JSON error body → message is the raw text
    // ------------------------------------------------------------------------

    @Test
    void nonJsonErrorBodyUsesRawAsMessage() {
        stub("/api/wallets", 502, "Bad Gateway");

        OpenAgentPayApiException ex = assertThrows(OpenAgentPayApiException.class,
                () -> client().listWallets());

        assertEquals(502, ex.status());
        assertEquals("http_502", ex.code());
        assertEquals("Bad Gateway", ex.getMessage());
        assertEquals("Bad Gateway", ex.raw());
    }

    // ------------------------------------------------------------------------
    //  15. baseUrl required
    // ------------------------------------------------------------------------

    @Test
    void emptyBaseUrlRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> OpenAgentPayClient.builder().baseUrl("").build());
    }
}

/*
 * OpenAgentPay Java SDK — in-process engine: MockConnector
 * ========================================================
 *
 * A deterministic test connector. settle() always succeeds and returns a tx
 * hash derived purely from the request, so tests can assert exact values
 * without network or randomness.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Deterministic, in-memory {@link Connector} for tests. */
public final class MockConnector implements Connector {

    private final String provider;

    public MockConnector() {
        this("mock");
    }

    public MockConnector(String provider) {
        this.provider = provider;
    }

    @Override
    public SettlementResult settle(PaymentRequest req) {
        return new SettlementResult(true, deterministicHash(req), req.amount(), provider);
    }

    @Override
    public String provider() {
        return provider;
    }

    /** {@code 0x} + sha-256 of "session|atomic|currency|recipient" — stable per request. */
    private String deterministicHash(PaymentRequest req) {
        String seed = req.sessionId()
                + "|" + req.amount().amountAtomic()
                + "|" + req.amount().currency()
                + "|" + (req.recipient() == null ? "" : req.recipient());
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(seed.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(2 + digest.length * 2);
            sb.append("0x");
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}

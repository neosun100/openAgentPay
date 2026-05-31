/*
 * OpenAgentPay Java SDK — in-process engine: PaymentRequest
 * =========================================================
 *
 * What a Connector needs to settle a single payment: the session it belongs to,
 * the amount (atomic units), and an optional recipient address.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.util.Objects;

/** A single payment instruction handed to a {@link Connector}. */
public record PaymentRequest(String sessionId, Money amount, String recipient) {

    public PaymentRequest {
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(amount, "amount");
        // recipient is optional (nullable).
    }

    /** Convenience: no explicit recipient. */
    public PaymentRequest(String sessionId, Money amount) {
        this(sessionId, amount, null);
    }
}

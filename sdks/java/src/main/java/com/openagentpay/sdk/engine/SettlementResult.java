/*
 * OpenAgentPay Java SDK — in-process engine: SettlementResult
 * ===========================================================
 *
 * What a Connector returns after settling: success flag, tx hash, the settled
 * amount, and the provider that handled it.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.util.Objects;

/** Outcome of a {@link Connector#settle} call. */
public record SettlementResult(
        boolean success,
        String txHash,
        Money amount,
        String provider) {

    public SettlementResult {
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(provider, "provider");
        // txHash nullable when !success.
    }
}

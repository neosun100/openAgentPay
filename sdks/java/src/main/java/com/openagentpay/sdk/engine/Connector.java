/*
 * OpenAgentPay Java SDK — in-process engine: Connector
 * ====================================================
 *
 * The L4 wallet abstraction, in-process flavor. A Connector knows how to settle
 * a PaymentRequest against some backend (chain RPC, CEX REST, or a mock). The
 * engine owns budget bookkeeping; the connector owns settlement.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

/** Settles payments for a single wallet/provider. */
public interface Connector {

    /** Settle one payment. Implementations must not mutate engine state. */
    SettlementResult settle(PaymentRequest req);

    /** Stable provider id (e.g. {@code "hashkey"}, {@code "mock"}). */
    String provider();
}

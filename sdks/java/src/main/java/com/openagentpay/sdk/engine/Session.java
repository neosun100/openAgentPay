/*
 * OpenAgentPay Java SDK — in-process engine: Session
 * ==================================================
 *
 * A budget envelope. Holds the remaining budget in atomic units (BigInteger —
 * never float) plus the currency it's denominated in. The engine creates and
 * decrements sessions; this record is an immutable snapshot.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.math.BigInteger;
import java.util.Objects;

/**
 * Immutable session snapshot. {@code budgetAtomic} is the remaining spendable
 * amount in the smallest unit of {@code currency}; {@code decimals} is its scale.
 */
public record Session(
        String sessionId,
        BigInteger budgetAtomic,
        int decimals,
        String currency,
        int paymentCount) {

    public Session {
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(budgetAtomic, "budgetAtomic");
        Objects.requireNonNull(currency, "currency");
        if (budgetAtomic.signum() < 0) {
            throw new IllegalArgumentException("budgetAtomic must be >= 0: " + budgetAtomic);
        }
        if (paymentCount < 0) {
            throw new IllegalArgumentException("paymentCount must be >= 0: " + paymentCount);
        }
    }

    /** Remaining budget as a {@link Money} value. */
    public Money remaining() {
        return Money.ofAtomic(budgetAtomic, decimals, currency);
    }

    /** Copy with budget reduced by {@code spent} and payment count bumped. */
    Session afterSpend(BigInteger spent) {
        return new Session(sessionId, budgetAtomic.subtract(spent), decimals, currency,
                paymentCount + 1);
    }
}

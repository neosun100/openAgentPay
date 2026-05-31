/*
 * OpenAgentPay Java SDK — in-process engine: Money
 * ================================================
 *
 * Atomic-unit money value. Mirrors the TS canonical shape
 * { amountAtomic: string, decimals: number, currency: string } — never a float.
 * Payments must never carry IEEE-754 drift, so the amount is stored as a
 * stringified integer count of the smallest unit (e.g. "1500000" for 1.5 USDC
 * at 6 decimals).
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Immutable atomic-unit money. {@code amountAtomic} is a base-10 integer string
 * in the smallest unit of {@code currency}; {@code decimals} is the unit scale.
 *
 * <pre>{@code
 * Money m = Money.parse("1.5USDC");   // -> ("1500000", 6, "USDC")
 * BigInteger atomic = m.atomic();      // 1500000
 * }</pre>
 */
public record Money(String amountAtomic, int decimals, String currency) {

    /** Per-currency decimal scale. Defaults to 6 (USDC/USDT family) when unknown. */
    private static int decimalsFor(String currency) {
        return switch (currency) {
            case "USDC", "USDT", "PYUSD" -> 6;
            case "DAI", "ETH", "WETH" -> 18;
            case "BTC" -> 8;
            default -> 6;
        };
    }

    // "1.5USDC" / "1000USDC" / "0.000001USDC" — number then a currency symbol.
    private static final Pattern TOKEN =
            Pattern.compile("^\\s*(\\d+(?:\\.\\d+)?)\\s*([A-Za-z][A-Za-z0-9]*)\\s*$");

    /** Compact validation at construction: amount must be a non-negative integer string. */
    public Money {
        Objects.requireNonNull(amountAtomic, "amountAtomic");
        Objects.requireNonNull(currency, "currency");
        if (decimals < 0) {
            throw new IllegalArgumentException("decimals must be >= 0: " + decimals);
        }
        BigInteger v;
        try {
            v = new BigInteger(amountAtomic);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("amountAtomic not an integer: " + amountAtomic);
        }
        if (v.signum() < 0) {
            throw new IllegalArgumentException("amountAtomic must be >= 0: " + amountAtomic);
        }
    }

    /** The atomic amount as a {@link BigInteger}. */
    public BigInteger atomic() {
        return new BigInteger(amountAtomic);
    }

    /**
     * Parse a human token like {@code "1.5USDC"} into atomic units. The decimal
     * scale is inferred from the currency. Throws {@link IllegalArgumentException}
     * on malformed input or excess fractional precision.
     */
    public static Money parse(String token) {
        Objects.requireNonNull(token, "token");
        Matcher m = TOKEN.matcher(token);
        if (!m.matches()) {
            throw new IllegalArgumentException("malformed money token: " + token);
        }
        String numeric = m.group(1);
        String currency = m.group(2).toUpperCase();
        int decimals = decimalsFor(currency);

        BigDecimal scaled = new BigDecimal(numeric).movePointRight(decimals);
        // Reject sub-atomic precision (e.g. "1.5USDC" with decimals 0, or "0.0000001USDC").
        if (scaled.scale() > 0 && scaled.stripTrailingZeros().scale() > 0) {
            throw new IllegalArgumentException(
                    "amount " + numeric + " exceeds " + decimals
                            + "-decimal precision for " + currency);
        }
        BigInteger atomic = scaled.toBigIntegerExact();
        return new Money(atomic.toString(), decimals, currency);
    }

    /** Build directly from atomic units. */
    public static Money ofAtomic(BigInteger atomic, int decimals, String currency) {
        return new Money(atomic.toString(), decimals, currency);
    }
}

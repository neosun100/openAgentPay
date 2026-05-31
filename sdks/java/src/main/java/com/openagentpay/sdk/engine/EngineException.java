/*
 * OpenAgentPay Java SDK — in-process engine: typed exception
 * ==========================================================
 *
 * Raised by {@link PaymentEngine} on engine-side faults (unknown session,
 * over-budget payment, currency mismatch). Carries a machine-readable code so
 * callers can branch without string-matching the message.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

/** Thrown by {@link PaymentEngine} for engine-side faults. */
public class EngineException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    /** Machine-readable fault codes. */
    public enum Code {
        UNKNOWN_SESSION,
        BUDGET_EXCEEDED,
        CURRENCY_MISMATCH,
        UNKNOWN_PROVIDER
    }

    private final Code code;

    public EngineException(Code code, String message) {
        super(message);
        this.code = code;
    }

    /** The machine-readable fault code. */
    public Code code() {
        return code;
    }

    @Override
    public String toString() {
        return "EngineException{code=" + code + ", message=" + getMessage() + "}";
    }
}

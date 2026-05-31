/*
 * OpenAgentPay Java SDK — in-process engine: PaymentEngine
 * ========================================================
 *
 * The in-process counterpart to the remote OpenAgentPayClient. Instead of
 * talking to oap-proxy over HTTP, this runs the budget + settlement loop in the
 * same JVM, delegating settlement to a registered Connector. This mirrors the
 * "in-process core" half of the multi-language SDK story (TS/Python/Go already
 * ship one).
 *
 * Budget accounting is in atomic units (BigInteger) — never float — so payment
 * math is exact. Over-budget payments and unknown sessions raise a typed
 * EngineException.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import java.math.BigInteger;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory payment engine. Thread-safe session map; per-session payment
 * processing is atomic via {@code compute}.
 *
 * <pre>{@code
 * PaymentEngine engine = new PaymentEngine(new MockConnector());
 * Session s = engine.createSession(Money.parse("5USDC"));
 * SettlementResult r = engine.processPayment(s.sessionId(), Money.parse("1.5USDC"), "0xRecip");
 * Money left = engine.getSession(s.sessionId()).remaining(); // 3.5 USDC -> "3500000"
 * }</pre>
 */
public final class PaymentEngine {

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Connector connector;
    private final AtomicLong counter = new AtomicLong();

    public PaymentEngine(Connector connector) {
        this.connector = Objects.requireNonNull(connector, "connector");
    }

    /** The settlement provider backing this engine. */
    public String provider() {
        return connector.provider();
    }

    // ------------------------------------------------------------------------
    //  Sessions
    // ------------------------------------------------------------------------

    /** Create a budget-bearing session. Returns the new session snapshot. */
    public Session createSession(Money budget) {
        Objects.requireNonNull(budget, "budget");
        String id = "sess_" + counter.incrementAndGet();
        Session s = new Session(id, budget.atomic(), budget.decimals(), budget.currency(), 0);
        sessions.put(id, s);
        return s;
    }

    /** Fetch a session snapshot. Throws {@link EngineException} if unknown. */
    public Session getSession(String sessionId) {
        Session s = sessions.get(sessionId);
        if (s == null) {
            throw new EngineException(EngineException.Code.UNKNOWN_SESSION,
                    "unknown session: " + sessionId);
        }
        return s;
    }

    /** Number of live sessions (mostly for tests/diagnostics). */
    public int sessionCount() {
        return sessions.size();
    }

    // ------------------------------------------------------------------------
    //  Payments
    // ------------------------------------------------------------------------

    /** Process a payment with no explicit recipient. */
    public SettlementResult processPayment(String sessionId, Money amount) {
        return processPayment(sessionId, amount, null);
    }

    /**
     * Decrement the session budget by {@code amount}, settle via the connector,
     * and return the result. Atomic per session: the budget check + decrement
     * happens under a single {@code compute}, so concurrent payments can't
     * overspend.
     *
     * @throws EngineException UNKNOWN_SESSION if the id is unknown,
     *                         CURRENCY_MISMATCH if amount currency differs,
     *                         BUDGET_EXCEEDED if amount > remaining budget.
     */
    public SettlementResult processPayment(String sessionId, Money amount, String recipient) {
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(amount, "amount");

        // Validate + reserve the budget atomically. We stash the failure (if any)
        // and the post-spend snapshot, then act outside the critical section.
        EngineException[] fault = new EngineException[1];

        sessions.compute(sessionId, (id, existing) -> {
            if (existing == null) {
                fault[0] = new EngineException(EngineException.Code.UNKNOWN_SESSION,
                        "unknown session: " + sessionId);
                return null; // leave absent
            }
            if (!existing.currency().equals(amount.currency())) {
                fault[0] = new EngineException(EngineException.Code.CURRENCY_MISMATCH,
                        "session is " + existing.currency() + " but payment is "
                                + amount.currency());
                return existing; // unchanged
            }
            BigInteger spend = amount.atomic();
            if (spend.compareTo(existing.budgetAtomic()) > 0) {
                fault[0] = new EngineException(EngineException.Code.BUDGET_EXCEEDED,
                        "payment " + spend + " exceeds remaining budget "
                                + existing.budgetAtomic());
                return existing; // unchanged
            }
            return existing.afterSpend(spend);
        });

        if (fault[0] != null) {
            throw fault[0];
        }

        // Budget already reserved; settle now.
        return connector.settle(new PaymentRequest(sessionId, amount, recipient));
    }
}

/*
 * OpenAgentPay Java SDK — in-process engine tests
 * ===============================================
 *
 * Network-free, deterministic tests for the in-process PaymentEngine: Money
 * parsing (happy + malformed), budget decrement, over-budget rejection, unknown
 * session, and multi-payment accounting. Tests are the spec — exact atomic-unit
 * assertions, error paths covered.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk.engine;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PaymentEngineTest {

    private PaymentEngine engine() {
        return new PaymentEngine(new MockConnector());
    }

    // ------------------------------------------------------------------------
    //  1. Money.parse happy path — "1.5USDC" -> ("1500000", 6, "USDC")
    // ------------------------------------------------------------------------

    @Test
    void moneyParseHappyPath() {
        Money m = Money.parse("1.5USDC");
        assertEquals("1500000", m.amountAtomic());
        assertEquals(6, m.decimals());
        assertEquals("USDC", m.currency());
        assertEquals(BigInteger.valueOf(1_500_000L), m.atomic());
    }

    // ------------------------------------------------------------------------
    //  2. Money.parse integer + whitespace + lowercase currency normalization
    // ------------------------------------------------------------------------

    @Test
    void moneyParseIntegerAndNormalization() {
        Money whole = Money.parse("1000USDC");
        assertEquals("1000000000", whole.amountAtomic()); // 1000 * 1e6

        Money spaced = Money.parse("  0.000001 usdc ");
        assertEquals("1", spaced.amountAtomic()); // smallest unit
        assertEquals("USDC", spaced.currency()); // upper-cased

        // 18-decimal currency scales differently.
        Money eth = Money.parse("1ETH");
        assertEquals("1000000000000000000", eth.amountAtomic());
        assertEquals(18, eth.decimals());
    }

    // ------------------------------------------------------------------------
    //  3. Money.parse malformed input throws
    // ------------------------------------------------------------------------

    @Test
    void moneyParseMalformedThrows() {
        assertThrows(IllegalArgumentException.class, () -> Money.parse("USDC"));      // no number
        assertThrows(IllegalArgumentException.class, () -> Money.parse("1.5"));       // no currency
        assertThrows(IllegalArgumentException.class, () -> Money.parse("abc"));       // junk
        assertThrows(IllegalArgumentException.class, () -> Money.parse("1.5 1USDC")); // garbage
        assertThrows(NullPointerException.class, () -> Money.parse(null));
    }

    // ------------------------------------------------------------------------
    //  4. Money.parse rejects sub-atomic precision
    // ------------------------------------------------------------------------

    @Test
    void moneyParseRejectsSubAtomicPrecision() {
        // USDC has 6 decimals; 7 fractional digits is sub-atomic.
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> Money.parse("0.0000001USDC"));
        assertTrue(ex.getMessage().contains("precision"));
    }

    // ------------------------------------------------------------------------
    //  5. Money constructor rejects non-integer / negative atomic strings
    // ------------------------------------------------------------------------

    @Test
    void moneyConstructorValidatesAtomicString() {
        assertThrows(IllegalArgumentException.class, () -> new Money("1.5", 6, "USDC")); // not integer
        assertThrows(IllegalArgumentException.class, () -> new Money("-5", 6, "USDC"));  // negative
        assertThrows(IllegalArgumentException.class, () -> new Money("xx", 6, "USDC"));  // junk
    }

    // ------------------------------------------------------------------------
    //  6. createSession + getSession round-trip
    // ------------------------------------------------------------------------

    @Test
    void createSessionStoresBudget() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("5USDC"));

        assertNotNull(s.sessionId());
        assertTrue(s.sessionId().startsWith("sess_"));
        assertEquals(BigInteger.valueOf(5_000_000L), s.budgetAtomic());
        assertEquals("USDC", s.currency());
        assertEquals(0, s.paymentCount());

        Session fetched = e.getSession(s.sessionId());
        assertEquals(s.sessionId(), fetched.sessionId());
        assertEquals("5000000", fetched.remaining().amountAtomic());
        assertEquals(1, e.sessionCount());
    }

    // ------------------------------------------------------------------------
    //  7. processPayment decrements budget and settles
    // ------------------------------------------------------------------------

    @Test
    void processPaymentDecrementsBudget() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("5USDC"));

        SettlementResult r = e.processPayment(s.sessionId(), Money.parse("1.5USDC"), "0xRecip");

        assertTrue(r.success());
        assertNotNull(r.txHash());
        assertTrue(r.txHash().startsWith("0x"));
        assertEquals("mock", r.provider());
        assertEquals("1500000", r.amount().amountAtomic());

        // 5 - 1.5 = 3.5 USDC remaining.
        Session after = e.getSession(s.sessionId());
        assertEquals("3500000", after.remaining().amountAtomic());
        assertEquals(1, after.paymentCount());
    }

    // ------------------------------------------------------------------------
    //  8. over-budget payment throws BUDGET_EXCEEDED and does not mutate budget
    // ------------------------------------------------------------------------

    @Test
    void overBudgetThrowsAndPreservesBudget() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("1USDC"));

        EngineException ex = assertThrows(EngineException.class,
                () -> e.processPayment(s.sessionId(), Money.parse("1.000001USDC")));
        assertEquals(EngineException.Code.BUDGET_EXCEEDED, ex.code());

        // Budget untouched after the rejected payment.
        Session after = e.getSession(s.sessionId());
        assertEquals("1000000", after.remaining().amountAtomic());
        assertEquals(0, after.paymentCount());
    }

    // ------------------------------------------------------------------------
    //  9. exact-budget payment is allowed (boundary), drains to zero
    // ------------------------------------------------------------------------

    @Test
    void exactBudgetPaymentAllowed() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("2USDC"));

        SettlementResult r = e.processPayment(s.sessionId(), Money.parse("2USDC"));
        assertTrue(r.success());
        assertEquals("0", e.getSession(s.sessionId()).remaining().amountAtomic());

        // A subsequent non-zero payment now fails.
        assertThrows(EngineException.class,
                () -> e.processPayment(s.sessionId(), Money.parse("0.000001USDC")));
    }

    // ------------------------------------------------------------------------
    //  10. unknown session throws UNKNOWN_SESSION (both getSession + processPayment)
    // ------------------------------------------------------------------------

    @Test
    void unknownSessionThrows() {
        PaymentEngine e = engine();

        EngineException g = assertThrows(EngineException.class, () -> e.getSession("nope"));
        assertEquals(EngineException.Code.UNKNOWN_SESSION, g.code());

        EngineException p = assertThrows(EngineException.class,
                () -> e.processPayment("nope", Money.parse("1USDC")));
        assertEquals(EngineException.Code.UNKNOWN_SESSION, p.code());
    }

    // ------------------------------------------------------------------------
    //  11. multi-payment accounting across several decrements
    // ------------------------------------------------------------------------

    @Test
    void multiPaymentAccounting() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("10USDC"));

        e.processPayment(s.sessionId(), Money.parse("2.5USDC"));
        e.processPayment(s.sessionId(), Money.parse("1.25USDC"));
        e.processPayment(s.sessionId(), Money.parse("0.75USDC"));

        Session after = e.getSession(s.sessionId());
        // 10 - 2.5 - 1.25 - 0.75 = 5.5 USDC -> 5500000 atomic.
        assertEquals("5500000", after.remaining().amountAtomic());
        assertEquals(3, after.paymentCount());

        // Fourth payment that would overspend the remaining 5.5 is rejected,
        // leaving the running total intact.
        assertThrows(EngineException.class,
                () -> e.processPayment(s.sessionId(), Money.parse("6USDC")));
        assertEquals("5500000", e.getSession(s.sessionId()).remaining().amountAtomic());
        assertEquals(3, e.getSession(s.sessionId()).paymentCount());
    }

    // ------------------------------------------------------------------------
    //  12. currency mismatch between session and payment throws
    // ------------------------------------------------------------------------

    @Test
    void currencyMismatchThrows() {
        PaymentEngine e = engine();
        Session s = e.createSession(Money.parse("5USDC"));

        EngineException ex = assertThrows(EngineException.class,
                () -> e.processPayment(s.sessionId(), Money.parse("0.001ETH")));
        assertEquals(EngineException.Code.CURRENCY_MISMATCH, ex.code());

        // Budget preserved.
        assertEquals("5000000", e.getSession(s.sessionId()).remaining().amountAtomic());
    }

    // ------------------------------------------------------------------------
    //  13. MockConnector tx hash is deterministic per request, differs across
    // ------------------------------------------------------------------------

    @Test
    void mockConnectorDeterministicHash() {
        MockConnector c = new MockConnector();
        PaymentRequest a = new PaymentRequest("sess_1", Money.parse("1USDC"), "0xA");
        PaymentRequest aAgain = new PaymentRequest("sess_1", Money.parse("1USDC"), "0xA");
        PaymentRequest b = new PaymentRequest("sess_1", Money.parse("2USDC"), "0xA");

        assertEquals(c.settle(a).txHash(), c.settle(aAgain).txHash()); // stable
        assertNotEquals(c.settle(a).txHash(), c.settle(b).txHash());   // amount changes hash
        assertEquals("mock", c.provider());
    }

    // ------------------------------------------------------------------------
    //  14. distinct sessions are independent; engine reports provider
    // ------------------------------------------------------------------------

    @Test
    void distinctSessionsAreIndependent() {
        PaymentEngine e = new PaymentEngine(new MockConnector("hashkey"));
        Session s1 = e.createSession(Money.parse("3USDC"));
        Session s2 = e.createSession(Money.parse("3USDC"));
        assertNotEquals(s1.sessionId(), s2.sessionId());

        e.processPayment(s1.sessionId(), Money.parse("1USDC"));

        // s1 decremented, s2 untouched.
        assertEquals("2000000", e.getSession(s1.sessionId()).remaining().amountAtomic());
        assertEquals("3000000", e.getSession(s2.sessionId()).remaining().amountAtomic());
        assertEquals("hashkey", e.provider());
        assertEquals(2, e.sessionCount());
    }
}

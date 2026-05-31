/*
 * OpenAgentPay Java SDK — wire types
 * ==================================
 *
 * Request/response shapes for the oap-proxy / demo-api REST surface. These
 * mirror the JSON the server emits over the wire (camelCase, plain primitives),
 * matching the TS @openagentpay/sdk types.ts exactly. Optional fields are
 * modeled as nullable record components.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Wire model namespace. Each nested record maps 1:1 to a JSON shape on the
 * REST surface. {@code @JsonInclude(NON_NULL)} keeps optional fields out of
 * request bodies; {@code @JsonIgnoreProperties(ignoreUnknown = true)} keeps
 * responses forward-compatible if the server adds fields.
 */
public final class Models {

    private Models() {
    }

    // ========================================================================
    //  POST /api/session
    // ========================================================================

    /** Request body for {@code POST /api/session}. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CreateSessionRequest(
            @JsonProperty("budgetUsd") double budgetUsd,
            @JsonProperty("expiryMinutes") int expiryMinutes) {
    }

    /** Response from {@code POST /api/session} and {@code GET /api/session/:id}. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SessionResponse(
            @JsonProperty("sessionId") String sessionId,
            @JsonProperty("budgetUsd") double budgetUsd,
            @JsonProperty("expiryMinutes") int expiryMinutes,
            @JsonProperty("createdAt") String createdAt,
            @JsonProperty("expiresAt") String expiresAt) {
    }

    // ========================================================================
    //  POST /api/pay
    // ========================================================================

    /** Request body for {@code POST /api/pay}. recipient + walletProvider optional. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PayRequest(
            @JsonProperty("sessionId") String sessionId,
            @JsonProperty("amountUsdc") double amountUsdc,
            /** nullable */ @JsonProperty("recipient") String recipient,
            /** nullable */ @JsonProperty("walletProvider") String walletProvider) {

        /** Convenience: only the required fields. */
        public PayRequest(String sessionId, double amountUsdc) {
            this(sessionId, amountUsdc, null, null);
        }
    }

    /**
     * EIP-3009 {@code transferWithAuthorization} authorization tuple. All
     * numeric fields arrive stringified to survive JSON without precision loss.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PaymentAuthorization(
            @JsonProperty("from") String from,
            @JsonProperty("to") String to,
            @JsonProperty("value") String value,
            @JsonProperty("validAfter") String validAfter,
            @JsonProperty("validBefore") String validBefore,
            @JsonProperty("nonce") String nonce) {
    }

    /** Signed payment payload returned by the proxy. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PaymentPayload(
            @JsonProperty("chainId") int chainId,
            @JsonProperty("verifyingContract") String verifyingContract,
            @JsonProperty("authorization") PaymentAuthorization authorization,
            @JsonProperty("signature") String signature,
            @JsonProperty("v") int v,
            @JsonProperty("r") String r,
            @JsonProperty("s") String s) {
    }

    /** Response from {@code POST /api/pay}. txHash/explorerUrl/error* optional. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PayResponse(
            @JsonProperty("success") boolean success,
            /** nullable */ @JsonProperty("txHash") String txHash,
            /** nullable */ @JsonProperty("explorerUrl") String explorerUrl,
            @JsonProperty("amountUsdc") double amountUsdc,
            @JsonProperty("amountAtomic") String amountAtomic,
            @JsonProperty("payer") String payer,
            @JsonProperty("recipient") String recipient,
            @JsonProperty("network") String network,
            @JsonProperty("walletProvider") String walletProvider,
            /** nullable */ @JsonProperty("errorCode") String errorCode,
            /** nullable */ @JsonProperty("errorMessage") String errorMessage,
            @JsonProperty("paymentPayload") PaymentPayload paymentPayload) {
    }

    // ========================================================================
    //  GET /api/wallets
    // ========================================================================

    /** A single wallet provider entry. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record WalletInfo(
            @JsonProperty("walletProvider") String walletProvider,
            @JsonProperty("displayName") String displayName,
            @JsonProperty("chainName") String chainName,
            @JsonProperty("chainId") int chainId,
            @JsonProperty("tokenLabel") String tokenLabel,
            @JsonProperty("tokenAddress") String tokenAddress,
            @JsonProperty("agentAddress") String agentAddress) {
    }

    /** Response from {@code GET /api/wallets}. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record WalletsResponse(
            @JsonProperty("wallets") List<WalletInfo> wallets,
            @JsonProperty("defaultProvider") String defaultProvider) {
    }

    // ========================================================================
    //  payOnce convenience
    // ========================================================================

    /** Request for {@link OpenAgentPayClient#payOnce}. expiryMinutes nullable (defaults to 60). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PayOnceRequest(
            @JsonProperty("budgetUsd") double budgetUsd,
            @JsonProperty("amountUsdc") double amountUsdc,
            /** nullable */ @JsonProperty("recipient") String recipient,
            /** nullable */ @JsonProperty("walletProvider") String walletProvider,
            /** nullable — defaults to 60 when null */ @JsonProperty("expiryMinutes") Integer expiryMinutes) {

        /** Convenience: only budget + amount; recipient/wallet default, expiry = 60. */
        public PayOnceRequest(double budgetUsd, double amountUsdc) {
            this(budgetUsd, amountUsdc, null, null, null);
        }
    }

    /** Result from {@link OpenAgentPayClient#payOnce} — the session and its first payment. */
    public record PayOnceResult(
            SessionResponse session,
            PayResponse payment) {
    }
}

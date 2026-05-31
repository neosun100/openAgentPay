import { describe, expect, it } from "vitest";
import {
  A2aDiscoveryAdapter,
  PROTOCOL_ID,
  X_PAYMENT_A2A_HEADER,
  parseAgentCard,
  validateAgentCard,
  negotiate,
  type A2a402Body,
  type AgentPaymentCard,
} from "../src/index.js";
import {
  ProtocolError,
  type ProtocolId,
  type SignedAuthorization,
  type WalletProviderId,
} from "@openagentpay/core";

const P = (s: string) => s as ProtocolId;
const W = (s: string) => s as WalletProviderId;

const merchantCard: AgentPaymentCard = {
  agentId: "did:web:merchant.example",
  displayName: "Example Merchant Agent",
  acceptedProtocols: [P("x402-v1"), P("mpp-v0.1")],
  acceptedAssets: [
    { symbol: "USDC", decimals: 6 },
    { symbol: "USDT", decimals: 6 },
  ],
  acceptedWallets: [W("coinbase-cdp"), W("hashkey")],
  spendLimits: { maxPerTxAtomic: "5000", currency: "USDC", decimals: 6 },
  wellKnownUrl: "https://merchant.example/.well-known/agent-card.json",
};

const payerCard: AgentPaymentCard = {
  agentId: "did:web:payer.example",
  displayName: "Payer Agent",
  acceptedProtocols: [P("mpp-v0.1"), P("x402-v1")],
  acceptedAssets: [{ symbol: "USDC", decimals: 6 }],
  acceptedWallets: [W("hashkey"), W("metamask")],
};

const baseBody: A2a402Body = {
  a2aVersion: "0.1",
  agentCard: merchantCard,
  paymentRequest: {
    protocol: P("x402-v1"),
    recipient: "0x000000000000000000000000000000000000dEaD",
    amount: { value: "1000", currency: "USDC", decimals: 6 },
    asset: { symbol: "USDC", decimals: 6 },
    walletProvider: W("coinbase-cdp"),
    description: "API access tier 1",
  },
};

describe("A2aDiscoveryAdapter — parse / detect", () => {
  it("parseAgentCard parses a JSON string card", () => {
    const card = parseAgentCard(JSON.stringify(merchantCard));
    expect(card.agentId).toBe("did:web:merchant.example");
    expect(card.acceptedProtocols).toContain("x402-v1");
  });

  it("validateAgentCard rejects a card missing agentId", () => {
    const broken: any = { ...merchantCard };
    delete broken.agentId;
    expect(() => validateAgentCard(broken)).toThrowError(/agentId/);
  });

  it("detect() returns true for an a2a discovery envelope", () => {
    const a = new A2aDiscoveryAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("detect() returns false for a foreign (ap2) body", () => {
    const a = new A2aDiscoveryAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: { ap2Version: "0.1", mandates: [] } })
    ).toBe(false);
  });
});

describe("A2aDiscoveryAdapter — negotiate", () => {
  it("negotiates the overlapping protocol + asset + wallet", () => {
    const choice = negotiate(payerCard, merchantCard);
    // payer prefers mpp-v0.1 first; merchant accepts it
    expect(choice.protocol).toBe("mpp-v0.1");
    expect(choice.asset.symbol).toBe("USDC");
    expect(choice.walletProvider).toBe("hashkey");
  });

  it("throws unsupported_scheme when there is no protocol overlap", () => {
    const isolated: AgentPaymentCard = {
      ...payerCard,
      acceptedProtocols: [P("oap-cex-v0.1")],
    };
    expect(() => negotiate(isolated, merchantCard)).toThrowError(/No overlapping protocol/);
  });

  it("throws when there is no wallet overlap", () => {
    const noWallet: AgentPaymentCard = {
      ...payerCard,
      acceptedWallets: [W("okx")],
    };
    expect(() => negotiate(noWallet, merchantCard)).toThrowError(/wallet provider/);
  });

  it("throws when there is no asset overlap", () => {
    const noAsset: AgentPaymentCard = {
      ...payerCard,
      acceptedAssets: [{ symbol: "BTC", decimals: 8 }],
    };
    expect(() => negotiate(noAsset, merchantCard)).toThrowError(/asset/);
  });
});

describe("A2aDiscoveryAdapter — parsePaymentRequired", () => {
  it("extracts the negotiated PaymentRequest tagged with the inner protocol", async () => {
    const a = new A2aDiscoveryAdapter();
    const req = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(req.protocol).toBe("x402-v1"); // inner settlement, NOT a2a-discovery
    expect(req.amount.amountAtomic).toBe("1000");
    expect(req.recipient).toBe("0x000000000000000000000000000000000000dEaD");
    expect(req.asset.symbol).toBe("USDC");
  });

  it("enforces the advertised spend limit", async () => {
    const a = new A2aDiscoveryAdapter();
    const overLimit: A2a402Body = {
      ...baseBody,
      paymentRequest: {
        ...baseBody.paymentRequest,
        amount: { value: "9999", currency: "USDC", decimals: 6 },
      },
    };
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: overLimit })
    ).rejects.toThrowError(/exceeds spendLimit/);
  });

  it("rejects when paymentRequest.protocol is not in the card's acceptedProtocols", async () => {
    const a = new A2aDiscoveryAdapter();
    const mismatched: A2a402Body = {
      ...baseBody,
      paymentRequest: { ...baseBody.paymentRequest, protocol: P("solana-pay-v0.1") },
    };
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: mismatched })
    ).rejects.toThrowError(/not in agentCard.acceptedProtocols/);
  });

  it("throws ProtocolError on unsupported a2aVersion", async () => {
    const a = new A2aDiscoveryAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { ...baseBody, a2aVersion: "9.9" },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("rejects a card whose signature fails the signature hook", async () => {
    const a = new A2aDiscoveryAdapter({
      signatureHook: {
        name: "AlwaysReject",
        async verify() {
          return { valid: false, reason: "bad sig" };
        },
      },
    });
    const signedBody: A2a402Body = {
      ...baseBody,
      agentCard: { ...merchantCard, signature: "0xdeadbeef" },
    };
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: signedBody })
    ).rejects.toThrowError(/signature verification/);
  });
});

describe("A2aDiscoveryAdapter — buildRetry", () => {
  it("emits the chosen settlement header", async () => {
    const a = new A2aDiscoveryAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: P("x402-v1"),
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "0xdead",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "1".repeat(64),
        rawPayload: {},
      },
      signer: "did:web:payer.example",
      signature: "0xsig",
      encoded: "base64payload",
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_A2A_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.a2aVersion).toBe("0.1");
    expect(decoded.settlement.protocol).toBe("x402-v1");
    expect(decoded.settlement.signature).toBe("0xsig");
    expect(PROTOCOL_ID).toBe("a2a-discovery-v0.1");
  });

  it("throws when the signed authorization lacks a signature", async () => {
    const a = new A2aDiscoveryAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: P("x402-v1"),
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: "0xdead",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "n",
        rawPayload: {},
      },
      signer: "did:web:payer.example",
      signature: "",
    };
    await expect(a.buildRetry(signed)).rejects.toThrowError(/requires a signature/);
  });
});

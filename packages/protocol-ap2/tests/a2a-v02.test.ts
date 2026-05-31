/**
 * Tests for the AP2 v0.2 A2A negotiation skeleton (Ap2V2Negotiator).
 *
 * Coverage:
 *   - protocol intersection picks expected (local-priority) winner
 *   - asset intersection picks expected (local-priority, by symbol) winner
 *   - no protocol overlap → rejected
 *   - no asset overlap → rejected
 *   - priority-order determinism (local order wins, not remote)
 *   - signature hook is invoked with the agreed tuple
 *   - default (no-op) proof on the emitted mandate stub
 *   - mandate stub shape: Cart + Payment chain, settlementProtocol == chosen
 *   - issuer override + injected clock flow into the stub
 */

import { describe, expect, it, vi } from "vitest";
import { Ap2V2Negotiator, AP2_V2_VERSION, NULL_AP2_V2_PROOF } from "../src/index.js";
import type { Ap2V2SignatureHook } from "../src/index.js";
import type { Asset, Mandate, ProtocolId } from "@openagentpay/core";
import type { AgentPaymentCard } from "@openagentpay/protocol-a2a-discovery";

const USDC: Asset = { symbol: "USDC", decimals: 6 };
const USDT: Asset = { symbol: "USDT", decimals: 6 };
const DAI: Asset = { symbol: "DAI", decimals: 18 };

function card(overrides: Partial<AgentPaymentCard> = {}): AgentPaymentCard {
  return {
    agentId: "did:web:agent.local",
    displayName: "Local Agent",
    acceptedProtocols: ["x402-v1", "mpp-v1"] as ProtocolId[],
    acceptedAssets: [USDC, USDT],
    acceptedWallets: ["coinbase-cdp"] as AgentPaymentCard["acceptedWallets"],
    ...overrides,
  };
}

describe("Ap2V2Negotiator — protocol intersection", () => {
  it("picks the local-priority protocol winner", () => {
    const local = card({
      agentId: "did:web:payer",
      acceptedProtocols: ["mpp-v1", "x402-v1"] as ProtocolId[],
    });
    const remote = card({
      agentId: "did:web:payee",
      acceptedProtocols: ["x402-v1", "mpp-v1"] as ProtocolId[],
    });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    expect(result.agreed).toBe(true);
    // local lists mpp-v1 first AND remote accepts it → mpp-v1 wins
    expect(result.chosenProtocol).toBe("mpp-v1");
    expect(result.rejected).toBeUndefined();
    expect(result.version).toBe(AP2_V2_VERSION);
  });

  it("rejects when there is no protocol overlap", () => {
    const local = card({ acceptedProtocols: ["x402-v1"] as ProtocolId[] });
    const remote = card({
      agentId: "did:web:other",
      acceptedProtocols: ["oap-cex-v1"] as ProtocolId[],
    });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    expect(result.agreed).toBe(false);
    expect(result.chosenProtocol).toBeUndefined();
    expect(result.mandate).toBeUndefined();
    expect(result.rejected).toMatch(/No overlapping protocol/);
  });
});

describe("Ap2V2Negotiator — asset intersection", () => {
  it("picks the local-priority asset winner by symbol", () => {
    const local = card({ acceptedAssets: [USDT, USDC] });
    const remote = card({ agentId: "did:web:payee", acceptedAssets: [USDC, USDT] });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    expect(result.agreed).toBe(true);
    // local lists USDT first; remote accepts it → USDT wins
    expect(result.chosenAsset).toEqual(USDT);
  });

  it("returns the local card's asset object (payer's decimals win)", () => {
    const localUsdc: Asset = { symbol: "USDC", decimals: 6 };
    const remoteUsdc: Asset = { symbol: "USDC", decimals: 8 }; // diverging decimals
    const local = card({ acceptedAssets: [localUsdc] });
    const remote = card({ agentId: "did:web:payee", acceptedAssets: [remoteUsdc] });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    expect(result.chosenAsset?.decimals).toBe(6);
  });

  it("rejects when protocols overlap but assets do not", () => {
    const local = card({ acceptedAssets: [USDC] });
    const remote = card({ agentId: "did:web:payee", acceptedAssets: [DAI] });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    expect(result.agreed).toBe(false);
    expect(result.chosenAsset).toBeUndefined();
    expect(result.mandate).toBeUndefined();
    expect(result.rejected).toMatch(/No overlapping asset/);
  });
});

describe("Ap2V2Negotiator — priority-order determinism", () => {
  it("local order decides the winner regardless of remote order", () => {
    const remote = card({
      agentId: "did:web:payee",
      acceptedProtocols: ["x402-v1", "mpp-v1", "oap-cex-v1"] as ProtocolId[],
      acceptedAssets: [USDC, USDT, DAI],
    });
    const localA = card({
      acceptedProtocols: ["oap-cex-v1", "x402-v1"] as ProtocolId[],
      acceptedAssets: [DAI, USDC],
    });
    const localB = card({
      acceptedProtocols: ["x402-v1", "oap-cex-v1"] as ProtocolId[],
      acceptedAssets: [USDC, DAI],
    });
    const a = new Ap2V2Negotiator().negotiate(localA, remote);
    const b = new Ap2V2Negotiator().negotiate(localB, remote);
    expect(a.chosenProtocol).toBe("oap-cex-v1");
    expect(a.chosenAsset).toEqual(DAI);
    expect(b.chosenProtocol).toBe("x402-v1");
    expect(b.chosenAsset).toEqual(USDC);
  });

  it("is deterministic across repeated calls", () => {
    const local = card();
    const remote = card({ agentId: "did:web:payee" });
    const neg = new Ap2V2Negotiator();
    const r1 = neg.negotiate(local, remote);
    const r2 = neg.negotiate(local, remote);
    expect(r1.chosenProtocol).toBe(r2.chosenProtocol);
    expect(r1.chosenAsset).toEqual(r2.chosenAsset);
  });
});

describe("Ap2V2Negotiator — signature hook", () => {
  it("invokes the injected signature hook with the agreed tuple", () => {
    const hook = vi.fn<Ap2V2SignatureHook>(() => ({
      type: "Ed25519Signature2020",
      created: "2026-05-31T00:00:00Z",
      verificationMethod: "did:web:payer#k1",
      proofPurpose: "assertionMethod",
      proofValue: "z-signed-stub",
    }));
    const local = card({ agentId: "did:web:payer" });
    const remote = card({ agentId: "did:web:payee" });
    const result = new Ap2V2Negotiator({ signatureHook: hook }).negotiate(local, remote);

    expect(hook).toHaveBeenCalledTimes(1);
    const arg = hook.mock.calls[0]![0];
    expect(arg.localCard.agentId).toBe("did:web:payer");
    expect(arg.remoteCard.agentId).toBe("did:web:payee");
    expect(arg.chosenProtocol).toBe(result.chosenProtocol);
    expect(arg.chosenAsset).toEqual(result.chosenAsset);

    // the hook's proof flows onto every mandate in the stub
    for (const m of result.mandate as Mandate[]) {
      expect(m.proof.proofValue).toBe("z-signed-stub");
    }
  });

  it("does not invoke the hook when negotiation is rejected", () => {
    const hook = vi.fn<Ap2V2SignatureHook>(() => NULL_AP2_V2_PROOF);
    const local = card({ acceptedProtocols: ["x402-v1"] as ProtocolId[] });
    const remote = card({
      agentId: "did:web:payee",
      acceptedProtocols: ["oap-cex-v1"] as ProtocolId[],
    });
    new Ap2V2Negotiator({ signatureHook: hook }).negotiate(local, remote);
    expect(hook).not.toHaveBeenCalled();
  });

  it("defaults to the no-op proof when no hook is supplied", () => {
    const result = new Ap2V2Negotiator().negotiate(card(), card({ agentId: "did:web:payee" }));
    const [cart] = result.mandate as Mandate[];
    expect(cart!.proof).toEqual(NULL_AP2_V2_PROOF);
  });
});

describe("Ap2V2Negotiator — mandate stub shape", () => {
  it("emits a Cart + Payment chain with the chosen settlement protocol", () => {
    const local = card({ agentId: "did:web:payer" });
    const remote = card({ agentId: "did:web:payee" });
    const result = new Ap2V2Negotiator().negotiate(local, remote);
    const mandates = result.mandate as Mandate[];
    expect(mandates).toHaveLength(2);

    const cart = mandates.find((m) => m.type[1] === "ap2.CartMandate")!;
    const payment = mandates.find((m) => m.type[1] === "ap2.PaymentMandate")!;
    expect(cart).toBeDefined();
    expect(payment).toBeDefined();

    // Payment references the Cart; settlementProtocol == negotiated winner
    const paymentClaims = payment.credentialSubject.mandate;
    expect(paymentClaims.kind).toBe("ap2.PaymentMandate");
    if (paymentClaims.kind === "ap2.PaymentMandate") {
      expect(paymentClaims.cartMandateId).toBe(cart.id);
      expect(paymentClaims.settlementProtocol).toBe(result.chosenProtocol);
      expect(paymentClaims.presence).toBe("agent_present");
      expect(paymentClaims.settlementPayload["negotiation"]).toMatchObject({
        version: AP2_V2_VERSION,
        local: "did:web:payer",
        remote: "did:web:payee",
      });
    }

    // Cart currency matches the chosen asset; stub total is zero
    const cartClaims = cart.credentialSubject.mandate;
    if (cartClaims.kind === "ap2.CartMandate") {
      expect(cartClaims.currency).toBe(result.chosenAsset!.symbol);
      expect(cartClaims.decimals).toBe(result.chosenAsset!.decimals);
      expect(cartClaims.totalAtomic).toBe("0");
    }
  });

  it("honors issuer override and injected clock", () => {
    const fixed = Date.parse("2026-01-02T03:04:05Z");
    const result = new Ap2V2Negotiator({
      issuer: "did:web:custom-issuer",
      now: () => fixed,
    }).negotiate(card(), card({ agentId: "did:web:payee" }));
    const [cart] = result.mandate as Mandate[];
    expect(cart!.issuer).toBe("did:web:custom-issuer");
    expect(cart!.issuanceDate).toBe(new Date(fixed).toISOString());
  });

  it("defaults the issuer to the local card agentId", () => {
    const result = new Ap2V2Negotiator().negotiate(
      card({ agentId: "did:web:payer" }),
      card({ agentId: "did:web:payee" })
    );
    const [cart] = result.mandate as Mandate[];
    expect(cart!.issuer).toBe("did:web:payer");
  });
});

/**
 * Tests for @openagentpay/wallet-movement — Movement Pay protocol + wallet + crypto.
 *
 * Movement is an Aptos-compatible Move-VM L2, so these tests mirror the
 * wallet-aptos suite with MOVE branding + the movement: URL scheme.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  parseMovementPayUrl,
  buildMovementPayUrl,
  MovementPayProtocolAdapter,
  MovementConnector,
  DemoMovementSigner,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_MOVEMENT_HEADER,
  MOVE_COIN_TYPE,
  RealMovementSigner,
  generateMovementKeypair,
  keypairFromSeed,
  keypairFromPrivateKeyHex,
  authKeyFromPublicKey,
  canonicalTransferDescriptor,
} from "../src/index.js";
import { ProtocolError, type PaymentRequest, type Session, type UserId } from "@openagentpay/core";

const RECIPIENT = "0x" + "1f".repeat(32);
const USDC_TESTNET =
  "0x447721a30109c662dde9c73a0c2c9c9c459fb5e5a9c92f03c50fa69737f5d08d::usdc::USDC";

// ----------------------------------------------------------------------------
//  Crypto / keygen — the heart of the package
// ----------------------------------------------------------------------------

describe("Movement keygen", () => {
  it("generateMovementKeypair() yields 0x+64 hex for all three fields", () => {
    const kp = generateMovementKeypair();
    expect(kp.privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("address is sha3_256(pubkey || 0x00) — deterministic from seed", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = keypairFromSeed(seed);
    const b = keypairFromSeed(seed);
    expect(a.address).toBe(b.address);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    // authKeyFromPublicKey must reproduce the same address from the pubkey
    const pubBytes = Uint8Array.from(
      (a.publicKeyHex.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
    );
    expect(authKeyFromPublicKey(pubBytes)).toBe(a.address);
  });

  it("roundtrips privateKeyHex → keypair → same address", () => {
    const kp = generateMovementKeypair();
    const restored = keypairFromPrivateKeyHex(kp.privateKeyHex);
    expect(restored.address).toBe(kp.address);
    expect(restored.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it("distinct seeds produce distinct addresses", () => {
    const a = keypairFromSeed(new Uint8Array(32).fill(1));
    const b = keypairFromSeed(new Uint8Array(32).fill(2));
    expect(a.address).not.toBe(b.address);
  });

  it("rejects a non-32-byte seed", () => {
    expect(() => keypairFromSeed(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it("rejects a non-32-byte private key hex", () => {
    expect(() => keypairFromPrivateKeyHex("0xdeadbeef")).toThrow(/32 bytes/);
  });
});

// ----------------------------------------------------------------------------
//  RealMovementSigner — real Ed25519 signatures, verifiable
// ----------------------------------------------------------------------------

describe("RealMovementSigner", () => {
  it("produces a real, verifiable Ed25519 signature (0x+128 hex)", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(9) });
    const out = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000",
      coinType: USDC_TESTNET,
      reference: "REF1",
    });
    expect(out.signature).toMatch(/^0x[0-9a-f]{128}$/); // 64-byte Ed25519 sig
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1000",
      coinType: USDC_TESTNET,
      reference: "REF1",
    });
    expect(signer.verify(out.signature, descriptor)).toBe(true);
  });

  it("verify() rejects a tampered descriptor", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(9) });
    const out = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000",
    });
    const wrong = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "9999", // tampered amount
    });
    expect(signer.verify(out.signature, wrong)).toBe(false);
  });

  it("verify() rejects a malformed signature", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(9) });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1",
    });
    expect(signer.verify("0xZZZZ", descriptor)).toBe(false);
  });

  it("address derived by signer is 0x+64 hex", () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(2) });
    expect(signer.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signer.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("offline-safe by default (no submit hook → version 0, movement explorer url)", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(5) });
    const out = await signer.signAndSubmit({ recipient: RECIPIENT, amountAtomic: "1" });
    expect(out.version).toBe(0);
    expect(out.explorerUrl).toContain("explorer.movementnetwork.xyz");
  });

  it("invokes the pluggable submit hook when provided", async () => {
    let captured: Record<string, unknown> | undefined;
    const signer = new RealMovementSigner({
      seed: new Uint8Array(32).fill(5),
      submit: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return { version: 42, explorerUrl: "https://x/txn/abc" };
      },
    });
    const out = await signer.signAndSubmit({ recipient: RECIPIENT, amountAtomic: "7" });
    expect(out.version).toBe(42);
    expect(out.explorerUrl).toBe("https://x/txn/abc");
    expect(captured?.["signer"]).toBe(signer.address);
    expect(captured?.["publicKey"]).toBe(signer.publicKeyHex);
  });

  it("balanceReader hook is honored, defaults to 0 offline", async () => {
    const offline = new RealMovementSigner({ seed: new Uint8Array(32).fill(1) });
    expect(await offline.getBalance()).toBe(0n);
    const online = new RealMovementSigner({
      seed: new Uint8Array(32).fill(1),
      balanceReader: async () => 123n,
    });
    expect(await online.getBalance()).toBe(123n);
  });
});

// ----------------------------------------------------------------------------
//  URL parser / builder
// ----------------------------------------------------------------------------

describe("parseMovementPayUrl", () => {
  it("parses minimal URL", () => {
    const f = parseMovementPayUrl(`movement:${RECIPIENT}`);
    expect(f.recipient).toBe(RECIPIENT);
    expect(f.amount).toBeUndefined();
  });

  it("parses URL with all fields", () => {
    const url = `movement:${RECIPIENT}?amount=0.001&coin=${USDC_TESTNET}&reference=ABC123&label=Hello&message=Pay%20me&memo=invoice-1`;
    const f = parseMovementPayUrl(url);
    expect(f.amount).toBe("0.001");
    expect(f.coin).toBe(USDC_TESTNET);
    expect(f.reference).toEqual(["ABC123"]);
    expect(f.label).toBe("Hello");
    expect(f.message).toBe("Pay me");
    expect(f.memo).toBe("invoice-1");
  });

  it("rejects URLs without movement: scheme", () => {
    expect(() => parseMovementPayUrl("https://x")).toThrowError(ProtocolError);
  });

  it("rejects URL without recipient", () => {
    expect(() => parseMovementPayUrl("movement:")).toThrowError(/missing recipient/);
  });

  it("rejects non-0x recipient", () => {
    expect(() => parseMovementPayUrl("movement:NOT-AN-ADDRESS")).toThrowError(/0x address/);
  });

  it("round-trips parse → build → parse", () => {
    const original = `movement:${RECIPIENT}?amount=0.001&coin=${USDC_TESTNET}&reference=R1&label=X`;
    const fields = parseMovementPayUrl(original);
    const reparsed = parseMovementPayUrl(buildMovementPayUrl(fields));
    expect(reparsed.recipient).toBe(fields.recipient);
    expect(reparsed.amount).toBe(fields.amount);
    expect(reparsed.coin).toBe(fields.coin);
    expect(reparsed.reference).toEqual(fields.reference);
  });
});

// ----------------------------------------------------------------------------
//  ProtocolAdapter
// ----------------------------------------------------------------------------

describe("MovementPayProtocolAdapter", () => {
  it("detects body.movementPay URL", () => {
    const a = new MovementPayProtocolAdapter();
    const url = `movement:${RECIPIENT}?amount=0.001`;
    expect(a.detect({ statusCode: 402, headers: {}, body: { movementPay: url } })).toBe(true);
  });

  it("detects via x-movement-pay-url header", () => {
    const a = new MovementPayProtocolAdapter();
    const url = `movement:${RECIPIENT}?amount=0.001`;
    expect(
      a.detect({ statusCode: 402, headers: { "x-movement-pay-url": url }, body: { x402Version: 1 } })
    ).toBe(true);
  });

  it("rejects non-movement 402 bodies", () => {
    const a = new MovementPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("rejects non-402 status", () => {
    const a = new MovementPayProtocolAdapter();
    const url = `movement:${RECIPIENT}?amount=0.001`;
    expect(a.detect({ statusCode: 200, headers: {}, body: { movementPay: url } })).toBe(false);
  });

  it("native MOVE → MOVE currency, 8 decimals", async () => {
    const a = new MovementPayProtocolAdapter();
    const url = `movement:${RECIPIENT}?amount=0.5`;
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { movementPay: url } });
    expect(r.amount.currency).toBe("MOVE");
    expect(r.amount.decimals).toBe(8);
    expect(r.amount.amountAtomic).toBe("50000000"); // 0.5 MOVE
  });

  it("known USDC coin → USDC currency, 6 decimals", async () => {
    const a = new MovementPayProtocolAdapter();
    const url = `movement:${RECIPIENT}?amount=0.001&coin=${USDC_TESTNET}&reference=REF1&message=Pay%20me`;
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { movementPay: url } });
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
    expect(r.amount.amountAtomic).toBe("1000"); // 0.001 USDC
    expect(r.asset.contract).toBe(USDC_TESTNET);
    expect(r.nonce).toBe("REF1");
    expect(r.description).toBe("Pay me");
  });

  it("throws when amount is missing", async () => {
    const a = new MovementPayProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { movementPay: `movement:${RECIPIENT}` } })
    ).rejects.toThrowError(/amount/);
  });

  it("buildRetry emits X-PAYMENT-MOVEMENT header with the tx signature", async () => {
    const a = new MovementPayProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: RECIPIENT,
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "REF1",
        rawPayload: {},
      },
      signer: RECIPIENT,
      signature: "0xTXSIGdemo",
    });
    expect(env.headers[X_PAYMENT_MOVEMENT_HEADER]).toBe("0xTXSIGdemo");
  });
});

// ----------------------------------------------------------------------------
//  WalletConnector
// ----------------------------------------------------------------------------

describe("MovementConnector — capabilities", () => {
  it("reports walletProvider=movement with MOVE+USDC + ed25519/move/aptos-compatible flags", () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.find((a) => a.symbol === "MOVE")).toBeDefined();
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.features?.nonEvm).toBe(true);
    expect(caps.features?.ed25519).toBe(true);
    expect(caps.features?.moveVm).toBe(true);
    expect(caps.features?.aptosCompatible).toBe(true);
  });

  it("all supported assets have decimals <= 24", () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    for (const a of c.getCapabilities().supportedAssets) {
      expect(a.decimals).toBeLessThanOrEqual(24);
    }
  });

  it("displayName includes network", () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
      network: "mainnet",
    });
    expect(c.getCapabilities().displayName).toContain("mainnet");
  });
});

describe("MovementConnector.createInstrument + getBalance", () => {
  it("creates instrument with signer.address as publicHandle + stores publicKey", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(3) });
    const c = new MovementConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle).toMatch(/^0x[0-9a-f]{64}$/);
    expect(inst.providerMetadata?.["publicKey"]).toBe(signer.publicKeyHex);
  });

  it("idempotent — same userId returns same instrument", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("rejects empty userId", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    await expect(c.createInstrument({ userId: "" as UserId })).rejects.toThrow(/userId is required/);
  });

  it("getBalance reports signer balance for default MOVE coin", async () => {
    const signer = new DemoMovementSigner({ initialBalanceAtomic: "500000000" }); // 5 MOVE
    const c = new MovementConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("500000000");
    expect(bal.money.currency).toBe("MOVE");
    expect(bal.money.decimals).toBe(8);
  });

  it("getBalance throws on unknown instrumentId", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    await expect(c.getBalance("payment-instrument-movement-nope" as never)).rejects.toThrow(/not found/);
  });
});

describe("MovementConnector.signAuthorization + settle", () => {
  const buildReq = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
    protocol: PROTOCOL_ID,
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: RECIPIENT,
    asset: { symbol: "USDC", decimals: 6, contract: USDC_TESTNET },
    validAfter: 0,
    validBefore: 9_999_999_999,
    nonce: "REF_TEST",
    rawPayload: {},
    ...overrides,
  });

  it("happy path → real signature → SettlementResult.success=true", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(4) });
    const c = new MovementConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildReq(),
      session: {} as Session,
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{128}$/);
    const settled = await c.settle(signed);
    expect(settled.success).toBe(true);
    expect(settled.transactionRef).toBe(signed.signature);
    expect(settled.network).toMatch(/^movement-/);
    expect((settled.raw as Record<string, unknown>)["explorerUrl"]).toContain("movementnetwork.xyz");
  });

  it("rejects non-movement protocol", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: { protocol: "x402-v1" } as unknown as PaymentRequest,
        session: {} as Session,
      })
    ).rejects.toThrow(/only supports movement-pay-v1/);
  });

  it("signAuthorization throws on unknown instrumentId", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as never,
        request: buildReq(),
        session: {} as Session,
      })
    ).rejects.toThrow(/not found/);
  });

  it("settle returns failure when signature missing", async () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const r = await c.settle({
      request: buildReq(),
      signer: RECIPIENT,
      signature: "",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("generateNonce produces a 0x+64 hex string", () => {
    const c = new MovementConnector({
      signer: new DemoMovementSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    expect(c.generateNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("native MOVE request routes to MOVE coin type in extra", async () => {
    const signer = new RealMovementSigner({ seed: new Uint8Array(32).fill(8) });
    const c = new MovementConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: buildReq({
        amount: { amountAtomic: "100000000", decimals: 8, currency: "MOVE" },
        asset: { symbol: "MOVE", decimals: 8 },
      }),
      session: {} as Session,
    });
    expect((signed.extra as Record<string, unknown>)["coinType"]).toBe(MOVE_COIN_TYPE);
  });
});

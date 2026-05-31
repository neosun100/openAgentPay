/**
 * Tests for @openagentpay/wallet-ton — TON Pay protocol + wallet + crypto.
 */

import { describe, expect, it } from "vitest";
import {
  parseTonPayUrl,
  buildTonPayUrl,
  TonPayProtocolAdapter,
  TonConnector,
  MemoryInstrumentStore,
  RealTonSigner,
  generateTonKeypair,
  keypairFromSeed,
  keypairFromHex,
  encodeTonAddress,
  decodeTonAddress,
  isValidTonAddress,
  canonicalTransferDescriptor,
  crc16Ccitt,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_TON_HEADER,
} from "../src/index.js";
import {
  ProtocolError,
  type PaymentRequest,
  type Session,
  type UserId,
  type InstrumentId,
} from "@openagentpay/core";

// A deterministic real keypair for assertions.
const KP = keypairFromSeed(new Uint8Array(32).fill(9), { testOnly: true });
const RECIPIENT = generateTonKeypair({ testOnly: true }).address;

// ----------------------------------------------------------------------------
//  Keypair + address generation
// ----------------------------------------------------------------------------

describe("TON keypair + address", () => {
  it("generates a 48-char base64url address", () => {
    const kp = generateTonKeypair();
    expect(kp.address.length).toBe(48);
    expect(kp.address).toMatch(/^[A-Za-z0-9_-]{48}$/);
  });

  it("keypairFromSeed is deterministic", () => {
    const a = keypairFromSeed(new Uint8Array(32).fill(1));
    const b = keypairFromSeed(new Uint8Array(32).fill(1));
    expect(a.address).toBe(b.address);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.accountIdHex).toBe(b.accountIdHex);
  });

  it("keypairFromHex round-trips the seed", () => {
    const a = keypairFromSeed(new Uint8Array(32).fill(5), { testOnly: true });
    const b = keypairFromHex(a.secretSeedHex, { testOnly: true });
    expect(b.address).toBe(a.address);
  });

  it("rejects non-32-byte seeds", () => {
    expect(() => keypairFromSeed(new Uint8Array(16))).toThrowError(/32 bytes/);
  });

  it("exposes a raw workchain:account_id form", () => {
    expect(KP.rawAddress).toMatch(/^0:[0-9a-f]{64}$/);
  });
});

// ----------------------------------------------------------------------------
//  Address encode / decode / validate (CRC16-CCITT)
// ----------------------------------------------------------------------------

describe("TON address encode/decode", () => {
  it("encodes 32-byte account_id to 48 base64url chars", () => {
    const acct = new Uint8Array(32).fill(0xab);
    const addr = encodeTonAddress(acct, { testOnly: true });
    expect(addr.length).toBe(48);
    expect(isValidTonAddress(addr)).toBe(true);
  });

  it("decode recovers account_id, workchain, flags", () => {
    const acct = new Uint8Array(32).fill(0x42);
    const addr = encodeTonAddress(acct, { bounceable: true, testOnly: true, workchain: 0 });
    const dec = decodeTonAddress(addr);
    expect(dec.accountIdHex).toBe("42".repeat(32));
    expect(dec.bounceable).toBe(true);
    expect(dec.testOnly).toBe(true);
    expect(dec.workchain).toBe(0);
  });

  it("non-bounceable + masterchain flags survive round-trip", () => {
    const acct = new Uint8Array(32).fill(0x01);
    const addr = encodeTonAddress(acct, { bounceable: false, testOnly: false, workchain: -1 });
    const dec = decodeTonAddress(addr);
    expect(dec.bounceable).toBe(false);
    expect(dec.testOnly).toBe(false);
    expect(dec.workchain).toBe(-1);
  });

  it("rejects a CRC-tampered address", () => {
    const acct = new Uint8Array(32).fill(0x7);
    const addr = encodeTonAddress(acct, { testOnly: true });
    // Flip a char in the middle (account_id region) → CRC must fail.
    const idx = 10;
    const ch = addr[idx] === "A" ? "B" : "A";
    const tampered = addr.slice(0, idx) + ch + addr.slice(idx + 1);
    expect(isValidTonAddress(tampered)).toBe(false);
  });

  it("rejects wrong-length account_id", () => {
    expect(() => encodeTonAddress(new Uint8Array(16))).toThrowError(/32 bytes/);
  });

  it("crc16Ccitt matches known XModem vector for '123456789'", () => {
    // CRC16-CCITT/XMODEM("123456789") == 0x31C3
    const data = new TextEncoder().encode("123456789");
    expect(crc16Ccitt(data)).toBe(0x31c3);
  });
});

// ----------------------------------------------------------------------------
//  Real Ed25519 signing + verification (incl. tamper)
// ----------------------------------------------------------------------------

describe("RealTonSigner — sign + verify", () => {
  it("produces a 128-hex-char Ed25519 signature", async () => {
    const signer = new RealTonSigner({ seed: new Uint8Array(32).fill(3) });
    const { signature } = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      comment: "REF1",
    });
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("verify() returns true for a genuine signature", async () => {
    const signer = new RealTonSigner({ seed: new Uint8Array(32).fill(3) });
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "1000000",
      comment: "REF1",
    });
    const { signature } = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      comment: "REF1",
    });
    expect(signer.verify(signature, descriptor)).toBe(true);
  });

  it("verify() returns FALSE for a tampered message", async () => {
    const signer = new RealTonSigner({ seed: new Uint8Array(32).fill(3) });
    const { signature } = await signer.signAndSubmit({
      recipient: RECIPIENT,
      amountAtomic: "1000000",
      comment: "REF1",
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: RECIPIENT,
      amountAtomic: "9999999", // amount changed
      comment: "REF1",
    });
    expect(signer.verify(signature, tampered)).toBe(false);
  });

  it("offline path yields a deterministic mock txHash + explorer URL", async () => {
    const signer = new RealTonSigner({ seed: new Uint8Array(32).fill(4), network: "testnet" });
    const r1 = await signer.signAndSubmit({ recipient: RECIPIENT, amountAtomic: "1", comment: "X" });
    const r2 = await signer.signAndSubmit({ recipient: RECIPIENT, amountAtomic: "1", comment: "X" });
    expect(r1.txHash).toBe(r2.txHash);
    expect(r1.explorerUrl).toContain("testnet.tonviewer.com");
  });

  it("pluggable submit hook is invoked and its txHash is used", async () => {
    let called = false;
    const signer = new RealTonSigner({
      seed: new Uint8Array(32).fill(4),
      submit: async () => {
        called = true;
        return { txHash: "live_tx_123", explorerUrl: "https://x/y" };
      },
    });
    const r = await signer.signAndSubmit({ recipient: RECIPIENT, amountAtomic: "1" });
    expect(called).toBe(true);
    expect(r.txHash).toBe("live_tx_123");
  });
});

// ----------------------------------------------------------------------------
//  ton-pay URL parser / builder
// ----------------------------------------------------------------------------

describe("parseTonPayUrl", () => {
  it("parses minimal URL", () => {
    const f = parseTonPayUrl(`ton://transfer/${RECIPIENT}`);
    expect(f.recipient).toBe(RECIPIENT);
    expect(f.amount).toBeUndefined();
  });

  it("parses URL with all fields", () => {
    const url = `ton://transfer/${RECIPIENT}?amount=0.5&jetton=${RECIPIENT}&text=Pay%20me&nonce=abc`;
    const f = parseTonPayUrl(url);
    expect(f.amount).toBe("0.5");
    expect(f.jetton).toBe(RECIPIENT);
    expect(f.text).toBe("Pay me");
    expect(f.nonce).toBe("abc");
  });

  it("rejects URLs without ton:// scheme", () => {
    expect(() => parseTonPayUrl("https://x")).toThrowError(ProtocolError);
  });

  it("rejects invalid recipient address", () => {
    expect(() => parseTonPayUrl("ton://transfer/NOT-A-TON-ADDR")).toThrowError(/valid TON address/);
  });

  it("round-trips parse → build → parse", () => {
    const original = `ton://transfer/${RECIPIENT}?amount=0.5&text=Hi`;
    const fields = parseTonPayUrl(original);
    const reparsed = parseTonPayUrl(buildTonPayUrl(fields));
    expect(reparsed.recipient).toBe(fields.recipient);
    expect(reparsed.amount).toBe(fields.amount);
    expect(reparsed.text).toBe(fields.text);
  });
});

// ----------------------------------------------------------------------------
//  ProtocolAdapter
// ----------------------------------------------------------------------------

describe("TonPayProtocolAdapter", () => {
  it("detects body.tonPay URL", () => {
    const a = new TonPayProtocolAdapter();
    const url = `ton://transfer/${RECIPIENT}?amount=0.5`;
    expect(a.detect({ statusCode: 402, headers: {}, body: { tonPay: url } })).toBe(true);
  });

  it("detects via x-ton-pay-url header", () => {
    const a = new TonPayProtocolAdapter();
    const url = `ton://transfer/${RECIPIENT}?amount=0.5`;
    expect(
      a.detect({ statusCode: 402, headers: { "x-ton-pay-url": url }, body: {} })
    ).toBe(true);
  });

  it("rejects non-TON 402 bodies", () => {
    const a = new TonPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("native TON → 9 decimals", async () => {
    const a = new TonPayProtocolAdapter();
    const url = `ton://transfer/${RECIPIENT}?amount=0.5`;
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { tonPay: url } });
    expect(r.amount.currency).toBe("TON");
    expect(r.amount.decimals).toBe(9);
    expect(r.amount.amountAtomic).toBe("500000000");
  });

  it("known USDT jetton → 6 decimals", async () => {
    const usdt = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
    const a = new TonPayProtocolAdapter({ knownJettons: [usdt] });
    const url = `ton://transfer/${RECIPIENT}?amount=1.5&jetton=${usdt}`;
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { tonPay: url } });
    expect(r.amount.currency).toBe("USDT");
    expect(r.amount.decimals).toBe(6);
    expect(r.amount.amountAtomic).toBe("1500000");
  });

  it("throws when amount missing", async () => {
    const a = new TonPayProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { tonPay: `ton://transfer/${RECIPIENT}` } })
    ).rejects.toThrowError(/amount/);
  });

  it("buildRetry emits X-PAYMENT-TON header", async () => {
    const a = new TonPayProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
        recipient: RECIPIENT,
        asset: { symbol: "USDT", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "REF1",
        rawPayload: {},
      },
      signer: RECIPIENT,
      signature: "deadbeef",
    });
    expect(env.headers[X_PAYMENT_TON_HEADER]).toBe("deadbeef");
  });
});

// ----------------------------------------------------------------------------
//  WalletConnector
// ----------------------------------------------------------------------------

function makeConnector() {
  const signer = new RealTonSigner({ seed: new Uint8Array(32).fill(11), network: "testnet" });
  const store = new MemoryInstrumentStore();
  return { signer, connector: new TonConnector({ signer, instrumentStore: store, network: "testnet" }) };
}

describe("TonConnector — capabilities", () => {
  it("reports walletProvider=ton + Ed25519 + jetton features", () => {
    const { connector } = makeConnector();
    const caps = connector.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.find((a) => a.symbol === "TON")).toBeDefined();
    expect(caps.supportedAssets.find((a) => a.symbol === "USDT")).toBeDefined();
    expect(caps.features?.nonEvm).toBe(true);
    expect(caps.features?.ed25519).toBe(true);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("displayName includes network", () => {
    const { signer } = makeConnector();
    const c = new TonConnector({ signer, instrumentStore: new MemoryInstrumentStore(), network: "mainnet" });
    expect(c.getCapabilities().displayName).toContain("mainnet");
  });
});

describe("TonConnector — createInstrument + getBalance", () => {
  it("creates instrument with signer.address as publicHandle", async () => {
    const { signer, connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe(signer.address);
    expect(inst.publicHandle.length).toBe(48);
  });

  it("rejects empty userId", async () => {
    const { connector } = makeConnector();
    await expect(connector.createInstrument({ userId: "" as UserId })).rejects.toThrowError(/userId is required/);
  });

  it("idempotent — same userId returns same instrument", async () => {
    const { connector } = makeConnector();
    const a = await connector.createInstrument({ userId: "alice" as UserId });
    const b = await connector.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("getBalance reports atomic units (offline → 0)", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "alice" as UserId });
    const bal = await connector.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.currency).toBe("USDT");
  });

  it("getBalance with custom balanceReader returns its value", async () => {
    const signer = new RealTonSigner({
      seed: new Uint8Array(32).fill(12),
      balanceReader: async () => 7000000n,
    });
    const c = new TonConnector({ signer, instrumentStore: new MemoryInstrumentStore() });
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("7000000");
  });

  it("getBalance throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(connector.getBalance("nope" as InstrumentId)).rejects.toThrowError(/not found/);
  });
});

describe("TonConnector — signAuthorization + settle", () => {
  function req(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
    return {
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDT" },
      recipient: RECIPIENT,
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "REF_TEST",
      rawPayload: {},
      ...overrides,
    };
  }

  it("happy path → real signature + settle success", async () => {
    const { signer, connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "alice" as UserId });
    const signed = await connector.signAuthorization({
      instrumentId: inst.id,
      request: req(),
      session: {} as Session,
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);
    const settled = await connector.settle(signed);
    expect(settled.success).toBe(true);
    expect(typeof settled.transactionRef).toBe("string");
    expect(settled.network).toBe("ton-testnet");
    expect((settled.raw as Record<string, unknown>)["explorerUrl"]).toContain("tonviewer.com");
  });

  it("rejects non-ton protocol", async () => {
    const { connector } = makeConnector();
    const inst = await connector.createInstrument({ userId: "alice" as UserId });
    await expect(
      connector.signAuthorization({
        instrumentId: inst.id,
        request: req({ protocol: "x402-v1" as PaymentRequest["protocol"] }),
        session: {} as Session,
      })
    ).rejects.toThrowError(/only supports ton-pay-v1/);
  });

  it("signAuthorization throws on unknown instrumentId", async () => {
    const { connector } = makeConnector();
    await expect(
      connector.signAuthorization({
        instrumentId: "bogus" as InstrumentId,
        request: req(),
        session: {} as Session,
      })
    ).rejects.toThrowError(/not found/);
  });

  it("settle returns failure when signature missing", async () => {
    const { signer, connector } = makeConnector();
    const r = await connector.settle({
      request: req(),
      signer: signer.address,
      signature: "",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("generateNonce produces non-empty hex string", () => {
    const { connector } = makeConnector();
    const n = connector.generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
});

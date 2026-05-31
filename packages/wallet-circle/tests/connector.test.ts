/**
 * Unit tests for CircleConnector + RealCircleSigner.
 *
 * Runs fully offline:
 *   - Keypair derivation is deterministic SHA-256 → secp256k1 (real address)
 *   - EIP-712 signing is REAL (verified here via viem verifyTypedData)
 *   - Broadcast defaults to a deterministic mock tx hash; a custom `submit`
 *     hook path is also exercised.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import { verifyTypedData, type Hex } from "viem";
import {
  CircleConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  CIRCLE_PROTOCOL,
} from "../src/connector.js";
import {
  RealCircleSigner,
  deriveCircleKeypair,
  generateEntitySecret,
  ensureHex32,
  EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
  type Eip3009SignedAuthorization,
} from "../src/real-signer.js";
import { resolveCircleChain } from "../src/chain.js";

// Throwaway entity secret (NEVER use for real funds)
const TEST_ENTITY_SECRET =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TEST_SALT = "test-wallet-set";
const FIXED_NOW_MS = 1778860654_000;

function makeConnector(opts: {
  gasStation?: boolean;
  network?: "base-sepolia" | "polygon-amoy" | "eth-sepolia";
} = {}): CircleConnector {
  return new CircleConnector({
    apiKey: "mock-circle-api-key",
    entitySecret: TEST_ENTITY_SECRET,
    walletSalt: TEST_SALT,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(opts.gasStation !== undefined ? { gasStation: opts.gasStation } : {}),
    ...(opts.network !== undefined ? { network: opts.network } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

function makeRequest(opts: { protocol?: ProtocolId } = {}): PaymentRequest {
  return {
    protocol: opts.protocol ?? CIRCLE_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "ab".repeat(32),
    rawPayload: {},
  };
}

function makeSession() {
  const usd: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" };
  return {
    id: "sess-1" as never,
    userId: userAlice,
    budget: usd,
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" } as Money,
    expiresAt: new Date(FIXED_NOW_MS + 3_600_000).toISOString(),
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    status: "active" as const,
  };
}

// ---------------------------------------------------------------------------
//  keypair derivation
// ---------------------------------------------------------------------------

describe("deriveCircleKeypair", () => {
  it("derives a real 0x EVM address", () => {
    const kp = deriveCircleKeypair(TEST_ENTITY_SECRET, TEST_SALT);
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(kp.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for same (secret, salt)", () => {
    const a = deriveCircleKeypair(TEST_ENTITY_SECRET, TEST_SALT);
    const b = deriveCircleKeypair(TEST_ENTITY_SECRET, TEST_SALT);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("yields distinct wallets for distinct salts", () => {
    const a = deriveCircleKeypair(TEST_ENTITY_SECRET, "wallet-a");
    const b = deriveCircleKeypair(TEST_ENTITY_SECRET, "wallet-b");
    expect(a.address).not.toBe(b.address);
  });

  it("generateEntitySecret produces a 32-byte hex string", () => {
    const s = generateEntitySecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
//  getCapabilities
// ---------------------------------------------------------------------------

describe("CircleConnector.getCapabilities", () => {
  it("reports circle provider, USDC asset, x402-v1 protocol", () => {
    const c = makeConnector();
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(CIRCLE_PROTOCOL);
  });

  it("exposes gasStation feature flag (default true)", () => {
    const caps = makeConnector().getCapabilities();
    expect(caps.features?.["gasStation"]).toBe(true);
    expect(caps.features?.["usdcNative"]).toBe(true);
    expect(caps.features?.["developerControlled"]).toBe(true);
  });

  it("respects gasStation=false override", () => {
    const caps = makeConnector({ gasStation: false }).getCapabilities();
    expect(caps.features?.["gasStation"]).toBe(false);
  });

  it("reports the configured network's chainId", () => {
    const caps = makeConnector({ network: "polygon-amoy" }).getCapabilities();
    expect(caps.features?.["chainId"]).toBe(80002);
    expect(caps.features?.["network"]).toBe("polygon-amoy");
  });
});

// ---------------------------------------------------------------------------
//  createInstrument
// ---------------------------------------------------------------------------

describe("CircleConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(b.publicHandle);
  });

  it("publicHandle is the derived EVM address", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.publicHandle).toBe(c.walletAddress);
    expect(inst.publicHandle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrumentId follows naming convention", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    expect(inst.id).toBe("payment-instrument-circle-alice");
  });

  it("rejects empty userId", async () => {
    const c = makeConnector();
    await expect(
      c.createInstrument({ userId: "" as UserId })
    ).rejects.toThrow(/userId is required/);
  });

  it("records gas-station + network in providerMetadata", async () => {
    const c = makeConnector({ network: "eth-sepolia" });
    const inst = await c.createInstrument(createInput);
    const md = inst.providerMetadata as Record<string, unknown>;
    expect(md["network"]).toBe("eth-sepolia");
    expect(md["chainId"]).toBe(11155111);
    expect(md["gasStation"]).toBe(true);
    expect(md["apiKeyConfigured"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  getBalance
// ---------------------------------------------------------------------------

describe("CircleConnector.getBalance", () => {
  it("returns 0 USDC offline (no balanceReader)", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("0");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
    expect(bal.asset.contract).toBe(
      resolveCircleChain("base-sepolia").usdc
    );
  });

  it("reads a wired balanceReader", async () => {
    const signer = new RealCircleSigner({
      entitySecret: TEST_ENTITY_SECRET,
      walletSalt: TEST_SALT,
      network: "base-sepolia",
      balanceReader: async () => 5_000_000n,
    });
    const c = new CircleConnector({
      apiKey: "mock",
      entitySecret: TEST_ENTITY_SECRET,
      instrumentStore: new MemoryInstrumentStore(),
      signer,
      now: () => FIXED_NOW_MS,
    });
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.getBalance("payment-instrument-circle-nope" as never)
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
//  signAuthorization
// ---------------------------------------------------------------------------

describe("CircleConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: makeRequest({ protocol: "wrong-protocol" as ProtocolId }),
        session: makeSession(),
      })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("throws on unknown instrumentId", async () => {
    const c = makeConnector();
    await expect(
      c.signAuthorization({
        instrumentId: "bogus" as never,
        request: makeRequest(),
        session: makeSession(),
      })
    ).rejects.toThrow(/not found/);
  });

  it("produces a REAL, verifiable EIP-712 EIP-3009 signature", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const req = makeRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: makeSession(),
    });
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(signed.signature.length).toBeGreaterThan(2);
    expect(signed.signer).toBe(c.walletAddress);

    // Cryptographically verify the EIP-712 signature recovers the signer.
    const wire = (signed.extra as Record<string, unknown>)[
      "signed"
    ] as Eip3009SignedAuthorization;
    const info = resolveCircleChain("base-sepolia");
    const ok = await verifyTypedData({
      address: c.walletAddress,
      domain: {
        name: wire.domainName,
        version: "2",
        chainId: BigInt(info.chain.id),
        verifyingContract: info.usdc,
      },
      types: EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: wire.authorization.from,
        to: wire.authorization.to,
        value: BigInt(wire.authorization.value),
        validAfter: BigInt(wire.authorization.validAfter),
        validBefore: BigInt(wire.authorization.validBefore),
        nonce: wire.authorization.nonce as Hex,
      },
      signature: signed.signature as Hex,
    });
    expect(ok).toBe(true);
  });

  it("echoes the request fields in the signed authorization", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const req = makeRequest();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: makeSession(),
    });
    expect(signed.request.recipient).toBe(req.recipient);
    expect(signed.request.amount.amountAtomic).toBe(req.amount.amountAtomic);
    const extra = signed.extra as Record<string, unknown>;
    expect(extra["gasStation"]).toBe(true);
    expect(extra["network"]).toBe("base-sepolia");
  });
});

// ---------------------------------------------------------------------------
//  settle
// ---------------------------------------------------------------------------

describe("CircleConnector.settle", () => {
  it("offline → success with deterministic mock tx hash", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.network).toBe("circle-base-sepolia");
    const raw = result.raw as Record<string, unknown>;
    expect(raw["gasStation"]).toBe(true);
  });

  it("deterministic mock hash is stable for the same signature", async () => {
    const c = makeConnector();
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const r1 = await c.settle(signed);
    const r2 = await c.settle(signed);
    expect(r1.transactionRef).toBe(r2.transactionRef);
  });

  it("routes through a pluggable submit hook (gas-station path)", async () => {
    let sawGasStation: boolean | undefined;
    const signer = new RealCircleSigner({
      entitySecret: TEST_ENTITY_SECRET,
      walletSalt: TEST_SALT,
      network: "base-sepolia",
      submit: async (input) => {
        sawGasStation = input.gasStation;
        return {
          transactionHash: "0x" + "cd".repeat(32),
          explorerUrl: "https://example/tx",
        };
      },
    });
    const c = new CircleConnector({
      apiKey: "mock",
      entitySecret: TEST_ENTITY_SECRET,
      instrumentStore: new MemoryInstrumentStore(),
      signer,
      gasStation: true,
      now: () => FIXED_NOW_MS,
    });
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0x" + "cd".repeat(32));
    expect(sawGasStation).toBe(true);
  });

  it("returns failure when extra.signed is missing", async () => {
    const c = makeConnector();
    const result = await c.settle({
      request: makeRequest(),
      signer: "0x0",
      signature: "0x0",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("returns rpc_error when submit hook throws", async () => {
    const signer = new RealCircleSigner({
      entitySecret: TEST_ENTITY_SECRET,
      walletSalt: TEST_SALT,
      network: "base-sepolia",
      submit: async () => {
        throw new Error("Circle gas-station unavailable");
      },
    });
    const c = new CircleConnector({
      apiKey: "mock",
      entitySecret: TEST_ENTITY_SECRET,
      instrumentStore: new MemoryInstrumentStore(),
      signer,
      now: () => FIXED_NOW_MS,
    });
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest(),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("rpc_error");
    expect(result.errorMessage).toContain("gas-station unavailable");
  });
});

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

describe("ensureHex32", () => {
  it("pads short input to 32 bytes", () => {
    expect(ensureHex32("0x01")).toBe("0x" + "0".repeat(62) + "01");
  });
  it("adds 0x prefix when missing", () => {
    expect(ensureHex32("ab".repeat(32))).toBe("0x" + "ab".repeat(32));
  });
});

/**
 * Tests for RealSolanaSigner — proves the Ed25519 keypair, base58 address,
 * and signature are cryptographically real (not demo stubs).
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  RealSolanaSigner,
  generateSolanaKeypair,
  keypairFromBase58,
  keypairFromSeed,
  canonicalTransferDescriptor,
} from "../src/real-signer.js";
import { base58 } from "@scure/base";

const VALID_RECIPIENT = "9aLzC5J9pvwPCzJ8aB3uDk5vTd23N7TTczbT8X4Hk6QH";

describe("generateSolanaKeypair", () => {
  it("produces a 32-byte seed and a base58 address that decodes to 32 bytes", () => {
    const kp = generateSolanaKeypair();
    expect(kp.secretSeedHex).toMatch(/^[0-9a-f]{64}$/);
    const pub = base58.decode(kp.address);
    expect(pub.length).toBe(32);
  });

  it("64-byte secret key decodes correctly (solana-keygen form)", () => {
    const kp = generateSolanaKeypair();
    const sk = base58.decode(kp.secretKeyBase58);
    expect(sk.length).toBe(64);
    // last 32 bytes == pubkey
    expect(base58.encode(sk.slice(32))).toBe(kp.address);
  });

  it("two generated keypairs differ (randomness)", () => {
    const a = generateSolanaKeypair();
    const b = generateSolanaKeypair();
    expect(a.address).not.toBe(b.address);
  });
});

describe("keypairFromBase58 / keypairFromSeed round-trips", () => {
  it("round-trips through the 64-byte base58 secret key", () => {
    const kp = generateSolanaKeypair();
    const restored = keypairFromBase58(kp.secretKeyBase58);
    expect(restored.address).toBe(kp.address);
    expect(restored.secretSeedHex).toBe(kp.secretSeedHex);
  });

  it("reconstructs the same address from a known seed", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = keypairFromSeed(seed);
    const b = keypairFromSeed(seed);
    expect(a.address).toBe(b.address); // deterministic
  });

  it("rejects a wrong-length seed", () => {
    expect(() => keypairFromSeed(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it("rejects a wrong-length base58 secret", () => {
    const sixteen = base58.encode(new Uint8Array(16));
    expect(() => keypairFromBase58(sixteen)).toThrow(/32 or 64/);
  });
});

describe("RealSolanaSigner.signAndSubmit", () => {
  it("produces a real, verifiable Ed25519 signature (offline path)", async () => {
    const signer = new RealSolanaSigner();
    const out = await signer.signAndSubmit({
      recipient: VALID_RECIPIENT,
      amountAtomic: "1000",
      reference: "REF1",
    });
    expect(out.signature.length).toBeGreaterThan(0);
    const descriptor = canonicalTransferDescriptor({
      from: signer.address,
      to: VALID_RECIPIENT,
      amountAtomic: "1000",
      reference: "REF1",
    });
    expect(signer.verify(out.signature, descriptor)).toBe(true);
  });

  it("a tampered descriptor fails verification", async () => {
    const signer = new RealSolanaSigner();
    const out = await signer.signAndSubmit({
      recipient: VALID_RECIPIENT,
      amountAtomic: "1000",
    });
    const tampered = canonicalTransferDescriptor({
      from: signer.address,
      to: VALID_RECIPIENT,
      amountAtomic: "9999", // changed
    });
    expect(signer.verify(out.signature, tampered)).toBe(false);
  });

  it("explorer URL carries the cluster suffix for devnet", async () => {
    const signer = new RealSolanaSigner({ cluster: "devnet" });
    const out = await signer.signAndSubmit({
      recipient: VALID_RECIPIENT,
      amountAtomic: "1",
    });
    expect(out.explorerUrl).toContain("?cluster=devnet");
  });

  it("invokes the submit hook when provided", async () => {
    let called = false;
    const signer = new RealSolanaSigner({
      cluster: "devnet",
      submit: async () => {
        called = true;
        return { slot: 42, explorerUrl: "https://x/tx/abc" };
      },
    });
    const out = await signer.signAndSubmit({
      recipient: VALID_RECIPIENT,
      amountAtomic: "1",
    });
    expect(called).toBe(true);
    expect(out.slot).toBe(42);
    expect(out.explorerUrl).toBe("https://x/tx/abc");
  });

  it("getBalance returns 0 offline and reads via balanceReader when wired", async () => {
    const offline = new RealSolanaSigner();
    expect(await offline.getBalance()).toBe(0n);
    const wired = new RealSolanaSigner({
      balanceReader: async () => 5_000_000n,
    });
    expect(await wired.getBalance("MINT")).toBe(5_000_000n);
  });
});

describe("canonicalTransferDescriptor", () => {
  it("is deterministic and stable in field ordering", () => {
    const a = canonicalTransferDescriptor({
      from: "A",
      to: "B",
      amountAtomic: "100",
      reference: "R",
    });
    const b = canonicalTransferDescriptor({
      from: "A",
      to: "B",
      amountAtomic: "100",
      reference: "R",
    });
    expect(a).toBe(b);
    expect(a).toContain("solana-pay/v1");
    expect(a).toContain("amount=100");
  });
});

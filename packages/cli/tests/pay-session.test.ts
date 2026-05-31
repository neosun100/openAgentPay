/**
 * Tests for `oap session` + `oap pay` (Task B3).
 *
 * We exercise the public `runCli` for argv/error paths, and call the command
 * functions directly with an injected in-memory manager for the happy paths
 * (so we don't depend on any external wallet package).
 */

import { describe, it, expect } from "vitest";

import { runCli } from "../src/cli.js";
import { parseAmount, AmountParseError } from "../src/commands/amount.js";
import { cmdSessionCreate, cmdSessionShow } from "../src/commands/session.js";
import { cmdPay } from "../src/commands/pay.js";
import { buildRuntime } from "../src/commands/session.js";
import {
  InMemoryPaymentManager,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type SettlementResult,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

function makeCtx() {
  let stdout = "";
  let stderr = "";
  return {
    ctx: {
      log: (s: string) => {
        stdout += s + "\n";
      },
      err: (s: string) => {
        stderr += s + "\n";
      },
      cwd: process.cwd(),
      env: process.env,
    },
    out: () => stdout,
    errOut: () => stderr,
  };
}

/** A minimal always-succeeds connector for the pay happy path. */
class FakeConnector implements WalletConnector {
  constructor(private readonly provider = "fakewallet") {}
  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: this.provider as WalletProviderId,
      displayName: "Fake Wallet",
      supportedAssets: [{ symbol: "USDC", decimals: 6 }],
      supportedProtocols: ["x402-v1"],
      requiresUserApproval: false,
      settlesOnChain: true,
    };
  }
  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    return {
      id: `inst-${input.userId}` as InstrumentId,
      userId: input.userId,
      walletProvider: this.provider as WalletProviderId,
      publicHandle: "0xFAKE",
      createdAt: new Date().toISOString(),
    };
  }
  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    return {
      instrumentId,
      asset: { symbol: "USDC", decimals: 6 },
      money: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
      fetchedAt: new Date().toISOString(),
    };
  }
  async signAuthorization(input: SignAuthorizationInput): Promise<SignedAuthorization> {
    return {
      request: input.request,
      signer: "0xFAKE",
      signature: "0xsig",
    };
  }
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    return {
      success: true,
      transactionRef: "0xdeadbeefcafef00d" as SettlementResult["transactionRef"],
      network: "fake-testnet",
      settledAt: new Date().toISOString(),
      settledAmount: signed.request.amount,
    };
  }
}

/** Build a manager pre-wired with the FakeConnector + the __instruments store. */
function managerWithFake(provider = "fakewallet") {
  const instruments = new Map<string, Instrument>();
  const mgr = new InMemoryPaymentManager({
    resolveInstrument: async (id: InstrumentId) => instruments.get(id),
  });
  mgr.registerConnector(new FakeConnector(provider));
  (mgr as InMemoryPaymentManager & { __instruments?: Map<string, Instrument> }).__instruments =
    instruments;
  return mgr;
}

// ===========================================================================
//  parseAmount
// ===========================================================================

describe("parseAmount", () => {
  it("parses 1.5USDC into 1500000 atomic units (6 decimals)", () => {
    expect(parseAmount("1.5USDC")).toEqual({
      amountAtomic: "1500000",
      decimals: 6,
      currency: "USDC",
    });
  });

  it("parses an integer amount with no fractional part", () => {
    expect(parseAmount("10USDC")).toEqual({
      amountAtomic: "10000000",
      decimals: 6,
      currency: "USDC",
    });
  });

  it("allows whitespace between number and currency", () => {
    expect(parseAmount("2 USDT")).toEqual({
      amountAtomic: "2000000",
      decimals: 6,
      currency: "USDT",
    });
  });

  it("uses 18 decimals for ETH", () => {
    expect(parseAmount("1ETH")).toEqual({
      amountAtomic: "1000000000000000000",
      decimals: 18,
      currency: "ETH",
    });
  });

  it("supports the smallest atomic unit exactly", () => {
    expect(parseAmount("0.000001USDC").amountAtomic).toBe("1");
  });

  it("lowercases currency suffix to canonical uppercase", () => {
    expect(parseAmount("3usdc").currency).toBe("USDC");
  });

  it("rejects empty input", () => {
    expect(() => parseAmount("")).toThrow(AmountParseError);
  });

  it("rejects missing currency", () => {
    expect(() => parseAmount("1.5")).toThrow(AmountParseError);
  });

  it("rejects missing number", () => {
    expect(() => parseAmount("USDC")).toThrow(AmountParseError);
  });

  it("rejects non-numeric garbage", () => {
    expect(() => parseAmount("abcUSDC")).toThrow(AmountParseError);
  });

  it("rejects too many decimal places for the currency", () => {
    expect(() => parseAmount("1.1234567USDC")).toThrow(/decimal places/);
  });

  it("rejects amounts that resolve to zero", () => {
    expect(() => parseAmount("0USDC")).toThrow(AmountParseError);
  });
});

// ===========================================================================
//  oap session
// ===========================================================================

describe("oap session create", () => {
  it("prints a session id, budget and expiry (exit 0)", async () => {
    const { ctx, out } = makeCtx();
    const code = await cmdSessionCreate(["--budget", "25", "--expiry", "30"], ctx);
    expect(code).toBe(0);
    expect(out()).toMatch(/payment-session-/);
    expect(out()).toContain("budget");
    expect(out()).toContain("$25");
  });

  it("uses defaults when no flags are passed", async () => {
    const { ctx, out } = makeCtx();
    const code = await cmdSessionCreate([], ctx);
    expect(code).toBe(0);
    expect(out()).toContain("$10");
  });

  it("rejects a non-positive budget (exit 2)", async () => {
    const { ctx, errOut } = makeCtx();
    const code = await cmdSessionCreate(["--budget", "-5"], ctx);
    expect(code).toBe(2);
    expect(errOut()).toContain("invalid --budget");
  });

  it("rejects an invalid expiry (exit 2)", async () => {
    const { ctx, errOut } = makeCtx();
    const code = await cmdSessionCreate(["--expiry", "nope"], ctx);
    expect(code).toBe(2);
    expect(errOut()).toContain("invalid --expiry");
  });

  it("via runCli prints help reference in top-level usage", async () => {
    const r = await runCli([]);
    expect(r.stdout).toContain("session create");
    expect(r.stdout).toContain("pay --to");
  });
});

describe("oap session show", () => {
  it("round-trips a created session within one manager (exit 0)", async () => {
    const mgr = managerWithFake();
    const create = makeCtx();
    await cmdSessionCreate(["--budget", "5"], create.ctx, mgr);
    const id = /(payment-session-[a-z0-9]+)/.exec(create.out())?.[1];
    expect(id).toBeTruthy();

    const show = makeCtx();
    const code = await cmdSessionShow([id!], show.ctx, mgr);
    expect(code).toBe(0);
    expect(show.out()).toContain(id!);
    expect(show.out()).toContain('"status"');
  });

  it("exits 5 when the session is unknown", async () => {
    const mgr = managerWithFake();
    const { ctx, errOut } = makeCtx();
    const code = await cmdSessionShow(["payment-session-doesnotexist"], ctx, mgr);
    expect(code).toBe(5);
    expect(errOut()).toContain("session not found");
  });

  it("exits 2 when <id> is missing", async () => {
    const { ctx, errOut } = makeCtx();
    const code = await cmdSessionShow([], ctx);
    expect(code).toBe(2);
    expect(errOut()).toContain("missing <id>");
  });
});

// ===========================================================================
//  oap pay
// ===========================================================================

describe("oap pay", () => {
  it("settles a payment with a registered connector and prints the tx hash", async () => {
    const mgr = managerWithFake("fakewallet");
    const { ctx, out } = makeCtx();
    const code = await cmdPay(
      ["--to", "0xRecipient", "--amount", "1.5USDC", "--wallet", "fakewallet"],
      ctx,
      mgr
    );
    expect(code).toBe(0);
    expect(out()).toContain("payment settled");
    expect(out()).toContain("0xdeadbeefcafef00d");
    expect(out()).toContain("1500000");
  });

  it("fails cleanly (exit 6) when the wallet connector is unknown", async () => {
    const mgr = managerWithFake("fakewallet");
    const { ctx, errOut } = makeCtx();
    const code = await cmdPay(
      ["--to", "0xRecipient", "--amount", "1USDC", "--wallet", "nosuchwallet"],
      ctx,
      mgr
    );
    expect(code).toBe(6);
    expect(errOut()).toContain("no wallet connector registered");
  });

  it("exits 2 on a malformed --amount", async () => {
    const mgr = managerWithFake();
    const { ctx, errOut } = makeCtx();
    const code = await cmdPay(
      ["--to", "0xRecipient", "--amount", "notanamount", "--wallet", "fakewallet"],
      ctx,
      mgr
    );
    expect(code).toBe(2);
    expect(errOut()).toContain("malformed amount");
  });

  it("exits 2 when --to is missing", async () => {
    const { ctx, errOut } = makeCtx();
    const code = await cmdPay(["--amount", "1USDC", "--wallet", "fakewallet"], ctx);
    expect(code).toBe(2);
    expect(errOut()).toContain("missing --to");
  });

  it("exits 6 when an explicit --session id is not found", async () => {
    const mgr = managerWithFake();
    const { ctx, errOut } = makeCtx();
    const code = await cmdPay(
      [
        "--to",
        "0xR",
        "--amount",
        "1USDC",
        "--wallet",
        "fakewallet",
        "--session",
        "payment-session-missing",
      ],
      ctx,
      mgr
    );
    expect(code).toBe(6);
    expect(errOut()).toContain("session not found");
  });

  it("reuses an explicit session id when it exists", async () => {
    const mgr = managerWithFake();
    const create = makeCtx();
    await cmdSessionCreate(["--budget", "100"], create.ctx, mgr);
    const id = /(payment-session-[a-z0-9]+)/.exec(create.out())?.[1]!;

    const pay = makeCtx();
    const code = await cmdPay(
      ["--to", "0xR", "--amount", "2USDC", "--wallet", "fakewallet", "--session", id],
      pay.ctx,
      mgr
    );
    expect(code).toBe(0);
    expect(pay.out()).toContain(id);
  });
});

// ===========================================================================
//  buildRuntime
// ===========================================================================

describe("buildRuntime", () => {
  it("builds a manager with no config when configPath is undefined", () => {
    const { ctx } = makeCtx();
    const { manager, config } = buildRuntime(ctx, undefined);
    expect(manager).toBeInstanceOf(InMemoryPaymentManager);
    expect(config).toBeUndefined();
  });
});

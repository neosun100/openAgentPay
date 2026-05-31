/**
 * @openagentpay/sdk — client tests
 *
 * All tests run against an injected fake `fetch` — no network, fully
 * deterministic. We assert on the request the client made (url, method,
 * headers, body) AND on how it decodes responses / errors.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import {
  OpenAgentPayClient,
  OpenAgentPayApiError,
  type FetchLike,
} from "../src/index.js";
import type {
  SessionResponse,
  PayResponse,
  WalletsResponse,
} from "../src/index.js";

// ----------------------------------------------------------------------------
//  Fake fetch helpers
// ----------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Build a fake fetch that records calls and returns scripted responses. */
function makeFakeFetch(
  responder: (call: RecordedCall) => FakeResponseSpec
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headersRecord: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      headersRecord[k.toLowerCase()] = v;
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: headersRecord,
      body,
    };
    calls.push(call);

    const spec = responder(call);
    const status = spec.status ?? 200;
    const text =
      spec.text !== undefined
        ? spec.text
        : spec.json !== undefined
        ? JSON.stringify(spec.json)
        : "";
    // Minimal Response-ish object covering what the client touches.
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

const BASE = "https://example.test";

const SESSION_FIXTURE: SessionResponse = {
  sessionId: "sess_123",
  budgetUsd: 5,
  expiryMinutes: 60,
  createdAt: "2026-05-30T00:00:00.000Z",
  expiresAt: "2026-05-30T01:00:00.000Z",
};

const PAY_FIXTURE: PayResponse = {
  success: true,
  txHash: "0xabc",
  explorerUrl: "https://sepolia.basescan.org/tx/0xabc",
  amountUsdc: 0.01,
  amountAtomic: "10000",
  payer: "0xPayer",
  recipient: "0xRecipient",
  network: "base-sepolia",
  walletProvider: "hashkey",
  paymentPayload: {
    chainId: 84532,
    verifyingContract: "0xUSDC",
    authorization: {
      from: "0xPayer",
      to: "0xRecipient",
      value: "10000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xnonce",
    },
    signature: "0xsig",
    v: 27,
    r: "0xr",
    s: "0xs",
  },
};

const WALLETS_FIXTURE: WalletsResponse = {
  wallets: [
    {
      walletProvider: "hashkey",
      displayName: "HashKey",
      chainName: "HashKey Chain Testnet",
      chainId: 133,
      tokenLabel: "USDC",
      tokenAddress: "0xUSDC",
      agentAddress: "0xAgent",
    },
  ],
  defaultProvider: "hashkey",
};

// ----------------------------------------------------------------------------
//  Tests
// ----------------------------------------------------------------------------

describe("OpenAgentPayClient", () => {
  it("createSession POSTs to /api/session with json body", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: SESSION_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.createSession({ budgetUsd: 5, expiryMinutes: 60 });

    expect(res).toEqual(SESSION_FIXTURE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/session`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ budgetUsd: 5, expiryMinutes: 60 });
  });

  it("pay POSTs to /api/pay and returns a success PayResponse", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: PAY_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.pay({ sessionId: "sess_123", amountUsdc: 0.01 });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe("0xabc");
    expect(res.paymentPayload.chainId).toBe(84532);
    expect(calls[0]!.url).toBe(`${BASE}/api/pay`);
    expect(calls[0]!.body).toEqual({ sessionId: "sess_123", amountUsdc: 0.01 });
  });

  it("pay includes recipient + walletProvider only when provided", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: PAY_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await client.pay({
      sessionId: "sess_123",
      amountUsdc: 0.5,
      recipient: "0xDest",
      walletProvider: "circle",
    });

    expect(calls[0]!.body).toEqual({
      sessionId: "sess_123",
      amountUsdc: 0.5,
      recipient: "0xDest",
      walletProvider: "circle",
    });
  });

  it("pay omits undefined optional fields from the wire body", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: PAY_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await client.pay({ sessionId: "sess_x", amountUsdc: 1 });

    const body = calls[0]!.body as Record<string, unknown>;
    expect("recipient" in body).toBe(false);
    expect("walletProvider" in body).toBe(false);
  });

  it("pay surfaces a 402 (payment required) as OpenAgentPayApiError", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 402,
      json: { error: "budget_exceeded", message: "over budget" },
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await expect(
      client.pay({ sessionId: "sess_123", amountUsdc: 999 })
    ).rejects.toBeInstanceOf(OpenAgentPayApiError);

    try {
      await client.pay({ sessionId: "sess_123", amountUsdc: 999 });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as OpenAgentPayApiError;
      expect(err.status).toBe(402);
      expect(err.code).toBe("budget_exceeded");
      expect(err.message).toBe("budget_exceeded");
      expect(err.raw).toEqual({ error: "budget_exceeded", message: "over budget" });
    }
  });

  it("pay surfaces a 400 (bad request) using the message field", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 400,
      json: { message: "amountUsdc must be positive" },
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    try {
      await client.pay({ sessionId: "sess_123", amountUsdc: -1 });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as OpenAgentPayApiError;
      expect(err.status).toBe(400);
      expect(err.message).toBe("amountUsdc must be positive");
      expect(err.code).toBe("http_400");
    }
  });

  it("getSession GETs /api/session/:id and returns the session", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: SESSION_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.getSession("sess_123");

    expect(res).toEqual(SESSION_FIXTURE);
    expect(calls[0]!.url).toBe(`${BASE}/api/session/sess_123`);
    expect(calls[0]!.method).toBe("GET");
    // GET must not set a content-type or body.
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
  });

  it("getSession url-encodes the id", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: SESSION_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await client.getSession("a/b c");

    expect(calls[0]!.url).toBe(`${BASE}/api/session/a%2Fb%20c`);
  });

  it("getSession throws OpenAgentPayApiError on 404", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 404,
      json: { error: "session_not_found" },
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    try {
      await client.getSession("missing");
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as OpenAgentPayApiError;
      expect(err).toBeInstanceOf(OpenAgentPayApiError);
      expect(err.status).toBe(404);
      expect(err.code).toBe("session_not_found");
    }
  });

  it("listWallets GETs /api/wallets", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: WALLETS_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.listWallets();

    expect(res.defaultProvider).toBe("hashkey");
    expect(res.wallets[0]!.chainId).toBe(133);
    expect(calls[0]!.url).toBe(`${BASE}/api/wallets`);
    expect(calls[0]!.method).toBe("GET");
  });

  it("getGovernance GETs /api/governance", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      json: { mode: "advisory", maxPerTx: 10 },
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.getGovernance();

    expect(res).toEqual({ mode: "advisory", maxPerTx: 10 });
    expect(calls[0]!.url).toBe(`${BASE}/api/governance`);
  });

  it("getAudit GETs /api/governance/audit", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      json: { events: [{ type: "settlement.completed" }] },
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const res = await client.getAudit();

    expect((res as { events: unknown[] }).events).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/governance/audit`);
  });

  it("payOnce creates a session then pays under it (two calls, threaded sessionId)", async () => {
    const { fetchImpl, calls } = makeFakeFetch((call) =>
      call.url.endsWith("/api/session")
        ? { json: SESSION_FIXTURE }
        : { json: PAY_FIXTURE }
    );
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    const { session, payment } = await client.payOnce({
      budgetUsd: 5,
      amountUsdc: 0.01,
    });

    expect(session).toEqual(SESSION_FIXTURE);
    expect(payment.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${BASE}/api/session`);
    expect(calls[0]!.body).toEqual({ budgetUsd: 5, expiryMinutes: 60 });
    expect(calls[1]!.url).toBe(`${BASE}/api/pay`);
    expect((calls[1]!.body as Record<string, unknown>)["sessionId"]).toBe(
      "sess_123"
    );
  });

  it("payOnce respects a custom expiryMinutes and forwards recipient", async () => {
    const { fetchImpl, calls } = makeFakeFetch((call) =>
      call.url.endsWith("/api/session")
        ? { json: SESSION_FIXTURE }
        : { json: PAY_FIXTURE }
    );
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await client.payOnce({
      budgetUsd: 20,
      amountUsdc: 2,
      expiryMinutes: 15,
      recipient: "0xMerchant",
    });

    expect(calls[0]!.body).toEqual({ budgetUsd: 20, expiryMinutes: 15 });
    expect((calls[1]!.body as Record<string, unknown>)["recipient"]).toBe(
      "0xMerchant"
    );
  });

  it("sets Authorization: Bearer header when apiKey is provided", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: WALLETS_FIXTURE }));
    const client = new OpenAgentPayClient({
      baseUrl: BASE,
      apiKey: "oap_sk_test",
      fetchImpl,
    });

    await client.listWallets();

    expect(calls[0]!.headers["authorization"]).toBe("Bearer oap_sk_test");
  });

  it("omits Authorization header when no apiKey is provided", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: WALLETS_FIXTURE }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    await client.listWallets();

    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl so paths don't double up", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: WALLETS_FIXTURE }));
    const client = new OpenAgentPayClient({
      baseUrl: `${BASE}///`,
      fetchImpl,
    });

    await client.listWallets();

    expect(calls[0]!.url).toBe(`${BASE}/api/wallets`);
  });

  it("falls back to a generic message on a non-JSON error body", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 500,
      text: "Internal Server Error",
    }));
    const client = new OpenAgentPayClient({ baseUrl: BASE, fetchImpl });

    try {
      await client.listWallets();
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as OpenAgentPayApiError;
      expect(err.status).toBe(500);
      expect(err.message).toBe("Internal Server Error");
      expect(err.code).toBe("http_500");
    }
  });

  it("throws when constructed without baseUrl", () => {
    expect(
      () =>
        new OpenAgentPayClient({
          baseUrl: "",
          fetchImpl: (async () => new Response()) as unknown as FetchLike,
        })
    ).toThrow(/baseUrl/);
  });
});

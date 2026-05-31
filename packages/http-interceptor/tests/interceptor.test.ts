/**
 * Tests for @openagentpay/http-interceptor — wrapFetch + wrapAxios.
 *
 * Uses fake fetch / axios implementations that return 402 first, then 200.
 */

import { describe, expect, it } from "vitest";
import {
  wrapFetch,
  wrapAxios,
  type AxiosLike,
  type AxiosLikeConfig,
  type AxiosLikeResponse,
  type FetchLike,
} from "../src/index.js";

// ---------------------------------------------------------------------------
//  fetch helpers
// ---------------------------------------------------------------------------

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

/** A fake fetch that returns the queued responses in order and records calls. */
function fakeFetch(
  queue: Response[]
): { fetch: FetchLike; calls: Array<{ input: unknown; init?: RequestInit }> } {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  let i = 0;
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init });
    const next = queue[i++];
    if (!next) throw new Error("fakeFetch: queue exhausted");
    return next;
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
//  wrapFetch
// ---------------------------------------------------------------------------

describe("wrapFetch", () => {
  it("passes through non-402 responses untouched", async () => {
    const { fetch, calls } = fakeFetch([res(200, { ok: true })]);
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async () => ({ headers: { "x-payment": "nope" } }),
    });
    const r = await wrapped("https://api.example/x");
    expect(r.status).toBe(200);
    expect(calls.length).toBe(1); // no retry
  });

  it("retries once with merged payment headers on 402", async () => {
    const { fetch, calls } = fakeFetch([
      res(402, { accepts: ["x402"] }, { "x-accept-payment": "x402" }),
      res(200, { paid: true }),
    ]);
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async (info) => {
        expect(info.status).toBe(402);
        expect(info.url).toBe("https://api.example/pay");
        expect((info.body as { accepts: string[] }).accepts[0]).toBe("x402");
        return { headers: { "x-payment": "signed-blob" } };
      },
    });
    const r = await wrapped("https://api.example/pay", {
      headers: { authorization: "Bearer t" },
    });
    expect(r.status).toBe(200);
    expect(calls.length).toBe(2);
    const retryHeaders = calls[1]?.init?.headers as Record<string, string>;
    expect(retryHeaders["x-payment"]).toBe("signed-blob");
    expect(retryHeaders["authorization"]).toBe("Bearer t"); // original preserved
  });

  it("surfaces the original 402 when hook returns null", async () => {
    const { fetch, calls } = fakeFetch([res(402, { accepts: [] })]);
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async () => null,
    });
    const r = await wrapped("https://api.example/x");
    expect(r.status).toBe(402);
    expect(calls.length).toBe(1); // no retry
  });

  it("parses JSON 402 bodies and exposes them to the hook", async () => {
    const { fetch } = fakeFetch([
      res(402, { amount: "100", asset: "USDC" }),
      res(200, "done"),
    ]);
    let seen: unknown;
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async (info) => {
        seen = info.body;
        return { headers: { "x-payment": "p" } };
      },
    });
    await wrapped("https://api.example/x");
    expect((seen as { asset: string }).asset).toBe("USDC");
  });

  it("sends a replacement body on retry when the hook provides one", async () => {
    const { fetch, calls } = fakeFetch([res(402, "pay"), res(200, "ok")]);
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async () => ({
        headers: { "x-payment": "p" },
        body: { settlement: "abc" },
      }),
    });
    await wrapped("https://api.example/x", { method: "POST" });
    const retryBody = calls[1]?.init?.body;
    expect(retryBody).toBe(JSON.stringify({ settlement: "abc" }));
  });

  it("accepts a URL object as input", async () => {
    const { fetch } = fakeFetch([res(402, ""), res(200, "ok")]);
    let url = "";
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async (info) => {
        url = info.url;
        return { headers: { "x-payment": "p" } };
      },
    });
    await wrapped(new URL("https://api.example/path"));
    expect(url).toBe("https://api.example/path");
  });

  it("does not retry more than once (a second 402 is surfaced)", async () => {
    const { fetch, calls } = fakeFetch([res(402, ""), res(402, "")]);
    const wrapped = wrapFetch(fetch, {
      onPaymentRequired: async () => ({ headers: { "x-payment": "p" } }),
    });
    const r = await wrapped("https://api.example/x");
    expect(r.status).toBe(402);
    expect(calls.length).toBe(2); // original + one retry, no third call
  });
});

// ---------------------------------------------------------------------------
//  wrapAxios
// ---------------------------------------------------------------------------

/** Fake axios that resolves the queued responses (with config echoed back). */
function fakeAxiosResolving(queue: AxiosLikeResponse[]): {
  client: AxiosLike;
  configs: AxiosLikeConfig[];
} {
  const configs: AxiosLikeConfig[] = [];
  let i = 0;
  const client: AxiosLike = {
    async request(config) {
      configs.push(config);
      const next = queue[i++];
      if (!next) throw new Error("fakeAxios: queue exhausted");
      return { ...next, config };
    },
  };
  return { client, configs };
}

/** Fake axios that REJECTS on 402 (default axios validateStatus behaviour). */
function fakeAxiosRejecting(
  first: AxiosLikeResponse,
  second: AxiosLikeResponse
): { client: AxiosLike; configs: AxiosLikeConfig[] } {
  const configs: AxiosLikeConfig[] = [];
  let i = 0;
  const client: AxiosLike = {
    async request(config) {
      configs.push(config);
      if (i++ === 0) {
        const err = new Error("Request failed with status code 402") as Error & {
          response: AxiosLikeResponse;
        };
        err.response = { ...first, config };
        throw err;
      }
      return { ...second, config };
    },
  };
  return { client, configs };
}

describe("wrapAxios", () => {
  it("passes through non-402 responses", async () => {
    const { client, configs } = fakeAxiosResolving([
      { status: 200, data: { ok: true } },
    ]);
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async () => ({ headers: { "x-payment": "p" } }),
    });
    const r = await wrapped.request({ url: "https://api.example/x" });
    expect(r.status).toBe(200);
    expect(configs.length).toBe(1);
  });

  it("retries once with merged headers when 402 resolves", async () => {
    const { client, configs } = fakeAxiosResolving([
      { status: 402, data: { accepts: ["x402"] }, headers: { "x-accept": "x402" } },
      { status: 200, data: { paid: true } },
    ]);
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async (info) => {
        expect(info.status).toBe(402);
        expect((info.body as { accepts: string[] }).accepts[0]).toBe("x402");
        return { headers: { "x-payment": "blob" } };
      },
    });
    const r = await wrapped.request({
      url: "https://api.example/x",
      headers: { authorization: "Bearer t" },
    });
    expect(r.status).toBe(200);
    expect(configs.length).toBe(2);
    expect(configs[1]?.headers?.["x-payment"]).toBe("blob");
    expect(configs[1]?.headers?.["authorization"]).toBe("Bearer t");
  });

  it("handles axios clients that REJECT on 402", async () => {
    const { client, configs } = fakeAxiosRejecting(
      { status: 402, data: { accepts: ["x402"] } },
      { status: 200, data: { paid: true } }
    );
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async () => ({ headers: { "x-payment": "blob" } }),
    });
    const r = await wrapped.request({ url: "https://api.example/x" });
    expect(r.status).toBe(200);
    expect(configs.length).toBe(2);
  });

  it("re-throws the original 402 rejection when hook returns null", async () => {
    const { client } = fakeAxiosRejecting(
      { status: 402, data: {} },
      { status: 200, data: {} }
    );
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async () => null,
    });
    await expect(
      wrapped.request({ url: "https://api.example/x" })
    ).rejects.toThrow(/402/);
  });

  it("surfaces a resolved 402 when hook returns null", async () => {
    const { client } = fakeAxiosResolving([{ status: 402, data: {} }]);
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async () => null,
    });
    const r = await wrapped.request({ url: "https://api.example/x" });
    expect(r.status).toBe(402);
  });

  it("sends replacement data on retry when hook provides body", async () => {
    const { client, configs } = fakeAxiosResolving([
      { status: 402, data: {} },
      { status: 200, data: {} },
    ]);
    const wrapped = wrapAxios(client, {
      onPaymentRequired: async () => ({
        headers: { "x-payment": "p" },
        body: { settlement: "xyz" },
      }),
    });
    await wrapped.request({ url: "https://api.example/x", method: "POST" });
    expect(configs[1]?.data).toEqual({ settlement: "xyz" });
  });

  it("preserves non-request axios properties via proxy", async () => {
    const base = {
      async request(config: AxiosLikeConfig): Promise<AxiosLikeResponse> {
        return { status: 200, data: {}, config };
      },
      defaults: { baseURL: "https://api.example" },
    };
    const wrapped = wrapAxios(base, {
      onPaymentRequired: async () => ({ headers: {} }),
    });
    expect((wrapped as typeof base).defaults.baseURL).toBe(
      "https://api.example"
    );
  });
});

/**
 * @openagentpay/sdk — remote HTTP client
 * ======================================
 *
 * The "client→proxy" half of the LiteLLM analogy. Point this at a running
 * `oap-proxy` / `demo-api` and call payments in one line — no in-process
 * wallet/protocol wiring. This is NOT a reimplementation of
 * `@openagentpay/core` (the in-process engine); it's the thin remote client.
 *
 * Dependency-light by design: no axios, no node-fetch — we use the global
 * `fetch` and let callers inject one for tests.
 *
 * @license Apache-2.0
 */

import type {
  AuditResponse,
  CreateSessionRequest,
  GovernanceResponse,
  PayOnceRequest,
  PayOnceResult,
  PayRequest,
  PayResponse,
  SessionResponse,
  WalletsResponse,
} from "./types.js";

/** Minimal `fetch` signature this SDK depends on (compatible with global `fetch`). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface OpenAgentPayClientOptions {
  /** Base URL of the oap-proxy / demo-api, e.g. "https://d1p7yxa99nxaye.cloudfront.net". */
  readonly baseUrl: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  readonly apiKey?: string;
  /** Injectable fetch — defaults to the global `fetch`. Used to test without network. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Typed error raised on any non-2xx response. The server returns a JSON body
 * of `{ error | message }`; we surface its status, a best-effort machine code,
 * a human message, and the raw parsed body for forensics.
 */
export class OpenAgentPayApiError extends Error {
  override readonly name = "OpenAgentPayApiError";
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly raw: unknown
  ) {
    super(message);
    // Restore prototype chain when targeting older runtimes.
    Object.setPrototypeOf(this, OpenAgentPayApiError.prototype);
  }
}

export class OpenAgentPayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAgentPayClientOptions) {
    if (!options.baseUrl) {
      throw new Error("OpenAgentPayClient: `baseUrl` is required");
    }
    // Normalize away any trailing slashes so we can safely concat paths.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;

    const injected = options.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else if (typeof globalThis.fetch === "function") {
      // Bind so `this` inside the platform fetch stays correct.
      this.fetchImpl = globalThis.fetch.bind(globalThis) as FetchLike;
    } else {
      throw new Error(
        "OpenAgentPayClient: no `fetch` available — pass `fetchImpl` explicitly"
      );
    }
  }

  // ==========================================================================
  //  Public API — one method per REST route
  // ==========================================================================

  /** POST /api/session — open a budgeted spending session. */
  async createSession(input: CreateSessionRequest): Promise<SessionResponse> {
    return this.request<SessionResponse>("POST", "/api/session", input);
  }

  /** POST /api/pay — execute a payment under an existing session. */
  async pay(input: PayRequest): Promise<PayResponse> {
    const body: PayRequest = {
      sessionId: input.sessionId,
      amountUsdc: input.amountUsdc,
      ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
      ...(input.walletProvider !== undefined
        ? { walletProvider: input.walletProvider }
        : {}),
    };
    return this.request<PayResponse>("POST", "/api/pay", body);
  }

  /** GET /api/session/:id — fetch a session (throws on 404). */
  async getSession(id: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(
      "GET",
      `/api/session/${encodeURIComponent(id)}`
    );
  }

  /** GET /api/wallets — list available wallet providers + the default. */
  async listWallets(): Promise<WalletsResponse> {
    return this.request<WalletsResponse>("GET", "/api/wallets");
  }

  /** GET /api/governance — current policy snapshot. */
  async getGovernance(): Promise<GovernanceResponse> {
    return this.request<GovernanceResponse>("GET", "/api/governance");
  }

  /** GET /api/governance/audit — recent audit events. */
  async getAudit(): Promise<AuditResponse> {
    return this.request<AuditResponse>("GET", "/api/governance/audit");
  }

  /**
   * Convenience: create a session and immediately pay under it. Returns both
   * the session and the payment so callers can keep paying on the same session
   * if they want.
   */
  async payOnce(input: PayOnceRequest): Promise<PayOnceResult> {
    const session = await this.createSession({
      budgetUsd: input.budgetUsd,
      expiryMinutes: input.expiryMinutes ?? 60,
    });
    const payment = await this.pay({
      sessionId: session.sessionId,
      amountUsdc: input.amountUsdc,
      ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
      ...(input.walletProvider !== undefined
        ? { walletProvider: input.walletProvider }
        : {}),
    });
    return { session, payment };
  }

  // ==========================================================================
  //  Internals
  // ==========================================================================

  private buildHeaders(hasBody: boolean): Record<string, string> {
    return {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const hasBody = body !== undefined;
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(hasBody),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    };

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const parsed = await this.parseBody(res);

    if (!res.ok) {
      throw this.toApiError(res.status, parsed);
    }
    return parsed as T;
  }

  /** Parse a response body as JSON, tolerating empty / non-JSON payloads. */
  private async parseBody(res: Response): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      return undefined;
    }
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private toApiError(status: number, raw: unknown): OpenAgentPayApiError {
    let message = `OpenAgentPay request failed with status ${status}`;
    let code = `http_${status}`;

    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const err = obj["error"];
      const msg = obj["message"];
      if (typeof err === "string" && err !== "") {
        message = err;
        code = err;
      } else if (typeof msg === "string" && msg !== "") {
        message = msg;
      }
      // Prefer an explicit machine code if the server supplied one.
      const explicitCode = obj["errorCode"] ?? obj["code"];
      if (typeof explicitCode === "string" && explicitCode !== "") {
        code = explicitCode;
      }
    } else if (typeof raw === "string" && raw !== "") {
      message = raw;
    }

    return new OpenAgentPayApiError(status, code, message, raw);
  }
}

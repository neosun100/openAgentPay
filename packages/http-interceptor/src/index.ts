/**
 * @openagentpay/http-interceptor
 * ===============================
 *
 * Drop-in wrappers that intercept HTTP 402 (Payment Required) responses and
 * transparently retry the original request once with payment headers supplied
 * by a caller-provided `onPaymentRequired` hook.
 *
 * This is the client-side glue that turns "the merchant returned 402" into
 * "pay, then replay the request" without the business code having to know
 * about x402 / MPP / AP2 at all. The actual payment logic lives behind the
 * hook (typically a thin shim over a PaymentManager).
 *
 *   wrapFetch(fetch, { onPaymentRequired })  → a fetch-compatible function
 *   wrapAxios(axiosLike, { onPaymentRequired }) → an axios-like { request }
 *
 * Both are pure and dependency-light: we never import `axios` or rely on a
 * specific `fetch` polyfill — we duck-type the minimal surface we need.
 *
 * @license Apache-2.0
 */

// ============================================================================
//  Shared hook contract
// ============================================================================

/**
 * Normalized view of a 402 response handed to {@link PaymentInterceptorOptions.onPaymentRequired}.
 */
export interface PaymentRequiredInfo {
  readonly status: number;
  /** Lower-cased header map (best-effort — depends on the transport). */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed body if JSON, otherwise the raw text/unknown payload. */
  readonly body: unknown;
  /** The requested URL (when known). */
  readonly url: string;
}

/**
 * What the hook returns to drive the retry:
 *   - `headers`: merged into the original request's headers
 *   - `body`:    optional replacement body for the retry
 *   - `null`:    "I can't pay" → surface the original 402 unchanged
 */
export interface PaymentRetryDirective {
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

export interface PaymentInterceptorOptions {
  /**
   * Called when a response has HTTP status 402. Resolve to a retry directive
   * (headers + optional body) to retry once, or `null` to give up and return
   * the original 402.
   */
  readonly onPaymentRequired: (
    info: PaymentRequiredInfo
  ) => Promise<PaymentRetryDirective | null>;
}

const PAYMENT_REQUIRED = 402;

// ============================================================================
//  Header helpers — transport-agnostic
// ============================================================================

/** Normalize any headers-shaped value into a plain lower-cased record. */
function toHeaderRecord(
  headers: unknown
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // Headers (WHATWG) — has forEach
  if (typeof (headers as Headers).forEach === "function" && !Array.isArray(headers)) {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  // Array of [k, v] tuples
  if (Array.isArray(headers)) {
    for (const pair of headers as Array<[string, string]>) {
      if (pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined) {
        out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
    }
    return out;
  }
  // Plain object
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

// ============================================================================
//  fetch wrapper
// ============================================================================

/** Minimal fetch signature we depend on (compatible with global `fetch`). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * Wrap a `fetch` implementation so HTTP 402 responses are auto-retried once
 * with payment headers from `onPaymentRequired`.
 */
export function wrapFetch(
  fetchImpl: FetchLike,
  options: PaymentInterceptorOptions
): FetchLike {
  return async function paymentAwareFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const first = await fetchImpl(input, init);
    if (first.status !== PAYMENT_REQUIRED) return first;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

    // Read the body without disturbing the response we may still return.
    const clone = typeof first.clone === "function" ? first.clone() : first;
    const body = await readBody(clone);

    const directive = await options.onPaymentRequired({
      status: first.status,
      headers: toHeaderRecord(first.headers),
      body,
      url,
    });
    if (directive === null) return first;

    // Merge payment headers into the original init.
    const mergedHeaders: Record<string, string> = {
      ...toHeaderRecord(init?.headers),
      ...directive.headers,
    };
    const retryInit: RequestInit = {
      ...(init ?? {}),
      headers: mergedHeaders,
      ...(directive.body !== undefined
        ? { body: serializeBody(directive.body) }
        : {}),
    };
    return fetchImpl(input, retryInit);
  };
}

async function readBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function serializeBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

// ============================================================================
//  axios wrapper (duck-typed — we never import axios)
// ============================================================================

/** Minimal axios request config we read/merge. */
export interface AxiosLikeConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  [key: string]: unknown;
}

/** Minimal axios response we inspect. */
export interface AxiosLikeResponse {
  status: number;
  headers?: unknown;
  data?: unknown;
  config?: AxiosLikeConfig;
  [key: string]: unknown;
}

/** Anything with a `request(config)` method — covers axios + custom clients. */
export interface AxiosLike {
  request(config: AxiosLikeConfig): Promise<AxiosLikeResponse>;
}

/**
 * Behaviour note: many axios setups REJECT on 402 (default `validateStatus`
 * only accepts 2xx). We handle both shapes:
 *   - resolved response with status 402, OR
 *   - rejected error whose `.response.status === 402`.
 */
export function wrapAxios<T extends AxiosLike>(
  axiosLike: T,
  options: PaymentInterceptorOptions
): T {
  const original = axiosLike.request.bind(axiosLike);

  async function paymentAwareRequest(
    config: AxiosLikeConfig
  ): Promise<AxiosLikeResponse> {
    let first: AxiosLikeResponse;
    try {
      first = await original(config);
    } catch (err) {
      const resp = extractAxiosErrorResponse(err);
      if (resp && resp.status === PAYMENT_REQUIRED) {
        const retried = await handle402(resp);
        if (retried !== null) return retried;
      }
      throw err;
    }

    if (first.status !== PAYMENT_REQUIRED) return first;
    const retried = await handle402(first);
    return retried ?? first;
  }

  async function handle402(
    resp: AxiosLikeResponse
  ): Promise<AxiosLikeResponse | null> {
    const sourceConfig = resp.config ?? config402Fallback(resp);
    const directive = await options.onPaymentRequired({
      status: resp.status,
      headers: toHeaderRecord(resp.headers),
      body: resp.data,
      url: sourceConfig.url ?? "",
    });
    if (directive === null) return null;

    const retryConfig: AxiosLikeConfig = {
      ...sourceConfig,
      headers: {
        ...toHeaderRecord(sourceConfig.headers),
        ...directive.headers,
      },
      ...(directive.body !== undefined ? { data: directive.body } : {}),
    };
    return original(retryConfig);
  }

  // Return a proxy so other axios props (get/post/interceptors) survive.
  return new Proxy(axiosLike, {
    get(target, prop, receiver) {
      if (prop === "request") return paymentAwareRequest;
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

function config402Fallback(resp: AxiosLikeResponse): AxiosLikeConfig {
  return { ...(resp.config ?? {}) };
}

function extractAxiosErrorResponse(err: unknown): AxiosLikeResponse | undefined {
  if (
    err &&
    typeof err === "object" &&
    "response" in err &&
    (err as { response?: unknown }).response &&
    typeof (err as { response: { status?: unknown } }).response.status ===
      "number"
  ) {
    return (err as { response: AxiosLikeResponse }).response;
  }
  return undefined;
}

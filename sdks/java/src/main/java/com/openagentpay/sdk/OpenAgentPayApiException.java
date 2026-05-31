/*
 * OpenAgentPay Java SDK — typed API exception
 * ===========================================
 *
 * Raised on any non-2xx response. Mirrors the TS OpenAgentPayApiError: carries
 * the HTTP status, a best-effort machine code, a human message, and the raw
 * response body string for forensics.
 *
 * License: Apache-2.0
 */
package com.openagentpay.sdk;

/** Thrown by {@link OpenAgentPayClient} on any non-2xx HTTP response. */
public class OpenAgentPayApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;
    private final String raw;

    public OpenAgentPayApiException(int status, String code, String message, String raw) {
        super(message);
        this.status = status;
        this.code = code;
        this.raw = raw;
    }

    /** HTTP status code of the failed response. */
    public int status() {
        return status;
    }

    /** Machine-readable error code (server-provided when available, else {@code http_<status>}). */
    public String code() {
        return code;
    }

    /** Raw response body as received (may be empty). */
    public String raw() {
        return raw;
    }

    @Override
    public String toString() {
        return "OpenAgentPayApiException{status=" + status
                + ", code=" + code
                + ", message=" + getMessage()
                + "}";
    }
}

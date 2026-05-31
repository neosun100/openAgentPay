/**
 * @openagentpay/protocol-ap2 public entrypoint.
 *
 * @license Apache-2.0
 */
export {
  Ap2ProtocolAdapter,
  NullMandateVerifier,
  PROTOCOL_ID,
  X_PAYMENT_AP2_HEADER,
  SUPPORTED_AP2_VERSIONS,
  buildIntentMandate,
  buildCartMandate,
  buildPaymentMandate,
  type Ap2402Body,
  type Ap2ProtocolAdapterConfig,
  type MandateVerifier,
} from "./adapter.js";

export {
  Ap2V2Negotiator,
  AP2_V2_VERSION,
  NULL_AP2_V2_PROOF,
  type Ap2NegotiationResult,
  type Ap2V2NegotiatorConfig,
  type Ap2V2SignatureHook,
} from "./a2a-v02.js";

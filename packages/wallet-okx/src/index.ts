/**
 * @openagentpay/wallet-okx public entrypoint.
 *
 * Re-exports the HMAC signer and the high-level WalletConnector.
 *
 * @license Apache-2.0
 */

// Re-export the shared OAP-CEX protocol id for conformance wiring.
export { PROTOCOL_ID } from "@openagentpay/protocol-cex-pay";

// Signer / credential layer
export {
  RealOkxSigner,
  generateOkxCredential,
  keypairFromCredential,
  verifyOkxSignature,
  buildPrehash,
  OKX_SIGN_ALG,
  type OkxCredential,
  type OkxAuthorizationPayload,
  type RealOkxSignerConfig,
} from "./real-signer.js";

// WalletConnector
export {
  OkxPayConnector,
  WALLET_PROVIDER_ID,
  MemoryInstrumentStore,
  __internal,
  type OkxPayConnectorConfig,
  type OkxSubmitHook,
  type InstrumentStore,
} from "./connector.js";

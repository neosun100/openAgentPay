/**
 * @openagentpay/wallet-bybit public entrypoint.
 *
 * Re-exports the HMAC-SHA256 signing primitive and the high-level
 * WalletConnector for Bybit Pay.
 *
 * @license Apache-2.0
 */

// Signer / credential primitives
export {
  RealBybitSigner,
  generateBybitKeypair,
  keypairFromSecret,
  buildPreimage,
  type BybitCredential,
  type RealBybitSignerConfig,
  type BybitSignParams,
} from "./real-signer.js";

// WalletConnector
export {
  BybitPayConnector,
  WALLET_PROVIDER_ID,
  PROTOCOL_ID,
  MemoryInstrumentStore,
  __internal,
  type BybitPayConnectorConfig,
  type BybitSubmitHook,
  type BybitSubmitResult,
  type InstrumentStore,
} from "./connector.js";

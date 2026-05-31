/**
 * @openagentpay/wallet-bitget public entrypoint.
 *
 * Bitget Wallet Pay connector — CEX-style HMAC-SHA256 authorization over the
 * OAP-CEX protocol (`cex-pay-v0.1`).
 *
 * @license Apache-2.0
 */

// Signer (HMAC-SHA256 sign/verify, offline keygen, pluggable submit hook)
export {
  RealBitgetSigner,
  generateBitgetKeypair,
  keypairFromParts,
  keypairFromSeed,
  canonicalize,
  hmacSign,
  hmacVerify,
  BITGET_SIG_ALG,
  type BitgetCredential,
  type BitgetAuthPayload,
  type BitgetSubmitHook,
  type BitgetSubmitResult,
  type RealBitgetSignerConfig,
} from "./real-signer.js";

// WalletConnector
export {
  BitgetPayConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  PROTOCOL_ID,
  type BitgetPayConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

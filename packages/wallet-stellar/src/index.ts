/**
 * @openagentpay/wallet-stellar public entrypoint.
 *
 * Stellar (SEP-31) WalletConnector with real Ed25519 StrKey identities and
 * offline-safe cryptographic signing. On-chain broadcast is behind a pluggable
 * `submit` hook on RealStellarSigner.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  StellarConnector,
  DemoStellarSigner,
  MemoryInstrumentStore,
  decimalToAtomic,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_STELLAR_HEADER,
  // Types
  type StellarConnectorConfig,
  type StellarSigner,
  type InstrumentStore,
  type Money,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no stellar-sdk needed for signing)
  RealStellarSigner,
  generateStellarKeypair,
  keypairFromSeed,
  keypairFromSecret,
  canonicalTransferDescriptor,
  // StrKey codec
  strkeyEncode,
  strkeyDecode,
  encodeAccountId,
  encodeSeed,
  decodeAccountId,
  decodeSeed,
  isValidAccountId,
  crc16xmodem,
  type StellarKeypair,
  type RealStellarSignerConfig,
} from "./real-signer.js";

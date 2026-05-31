/**
 * @openagentpay/wallet-ton public entrypoint.
 *
 * Provides BOTH a ProtocolAdapter (for parsing ton-pay-v1 402 responses) and a
 * WalletConnector (for executing the payment) for TON (The Open Network).
 * Ed25519-based, non-EVM — packaged together since both halves are required.
 *
 * @license Apache-2.0
 */

export {
  // Protocol layer
  TonPayProtocolAdapter,
  parseTonPayUrl,
  buildTonPayUrl,
  // Wallet layer
  TonConnector,
  DemoTonSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_TON_HEADER,
  // Types
  type TonPayAdapterConfig,
  type TonPayUrlFields,
  type TonConnectorConfig,
  type TonSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no @ton/ton needed for signing)
  RealTonSigner,
  generateTonKeypair,
  keypairFromSeed,
  keypairFromHex,
  encodeTonAddress,
  decodeTonAddress,
  isValidTonAddress,
  canonicalTransferDescriptor,
  crc16Ccitt,
  type TonKeypair,
  type TonAddressOptions,
  type DecodedTonAddress,
  type RealTonSignerConfig,
} from "./real-signer.js";

/**
 * @openagentpay/wallet-polkadot public entrypoint.
 *
 * A WalletConnector for the Substrate / Polkadot family using the Ed25519 key
 * variant (sr25519/schnorrkel intentionally avoided — see real-signer.ts).
 * Addresses are real SS58 strings; signatures are real, on-chain-verifiable
 * Ed25519. On-chain broadcast is pluggable; the default path is offline-safe.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  PolkadotConnector,
  DemoPolkadotSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_POLKADOT_HEADER,
  DOT_DECIMALS,
  USDT_DECIMALS,
  // Types
  type PolkadotConnectorConfig,
  type PolkadotSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no @polkadot/api needed for signing)
  RealPolkadotSigner,
  generatePolkadotKeypair,
  keypairFromSeed,
  keypairFromSeedHex,
  publicKeypairFromAddress,
  canonicalTransferDescriptor,
  // SS58 codec
  ss58Encode,
  ss58Decode,
  isValidSs58,
  SS58_PREFIX_POLKADOT,
  SS58_PREFIX_SUBSTRATE,
  type PolkadotKeypair,
  type RealPolkadotSignerConfig,
} from "./real-signer.js";

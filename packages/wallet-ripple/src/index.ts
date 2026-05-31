/**
 * @openagentpay/wallet-ripple public entrypoint.
 *
 * Provides a WalletConnector for the XRP Ledger. Bundled with a real, dependency
 * -light Ed25519 signer that emits genuine classic "r..." addresses + verifiable
 * signatures — no xrpl.js / ripple-keypairs required for the offline path.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  RippleConnector,
  DemoRippleSigner,
  MemoryInstrumentStore,
  decimalToDrops,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_RIPPLE_HEADER,
  // Types
  type RippleConnectorConfig,
  type RippleSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no xrpl.js needed for signing)
  RealRippleSigner,
  generateRippleKeypair,
  keypairFromSeed,
  keypairFromSeedHex,
  canonicalTransferDescriptor,
  // Codec primitives (XRPL custom base58check)
  base58Encode,
  base58Decode,
  base58CheckEncode,
  base58CheckDecode,
  accountIdFromPubkey,
  encodeAddress,
  decodeAddress,
  encodeSeed,
  decodeSeed,
  isValidAddress,
  XRPL_ALPHABET,
  type RippleKeypair,
  type RealRippleSignerConfig,
} from "./real-signer.js";

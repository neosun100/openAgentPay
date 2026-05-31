/**
 * @openagentpay/wallet-bitcoin public entrypoint.
 *
 * A WalletConnector for Bitcoin (native SegWit P2WPKH, testnet by default),
 * backed by a real secp256k1 signer with bech32 address derivation. Broadcast
 * stays behind the signer's pluggable `submit` hook so signing runs fully
 * offline — the cryptographic identity (keypair → tb1q… address → DER
 * signature) is entirely real and verifiable without a network.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  BitcoinConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_BITCOIN_HEADER,
  // Types
  type BitcoinConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (no bitcoinjs-lib needed for signing)
  RealBitcoinSigner,
  generateBitcoinKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  // Address codec (bech32 witness v0 P2WPKH)
  encodeSegwitV0Address,
  decodeSegwitV0Address,
  hash160,
  dsha256,
  hrpForNetwork,
  WITNESS_VERSION_V0,
  type BitcoinKeypair,
  type BitcoinNetwork,
  type RealBitcoinSignerConfig,
  type BitcoinSignResult,
} from "./real-signer.js";

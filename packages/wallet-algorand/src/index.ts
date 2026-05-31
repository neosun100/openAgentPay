/**
 * @openagentpay/wallet-algorand public entrypoint.
 *
 * Algorand WalletConnector (Ed25519, 58-char base32 checksum address) plus the
 * RealAlgorandSigner that produces real cryptographic signatures offline.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  AlgorandConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  // Types
  type AlgorandConnectorConfig,
  type AlgorandSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no algosdk needed for signing)
  RealAlgorandSigner,
  generateAlgorandKeypair,
  keypairFromSeed,
  keypairFromHex,
  canonicalTransferDescriptor,
  // Address codec
  encodeAlgorandAddress,
  decodeAlgorandAddress,
  isValidAlgorandAddress,
  type AlgorandKeypair,
  type RealAlgorandSignerConfig,
} from "./real-signer.js";

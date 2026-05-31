/**
 * @openagentpay/wallet-starknet public entrypoint.
 *
 * A WalletConnector for Starknet (STARK-friendly L2, Sepolia by default),
 * backed by a real secp256k1 signer with a deterministic felt252-shaped
 * address. Broadcast stays behind the signer's pluggable `submit` hook so
 * signing runs fully offline — the cryptographic identity (keypair →
 * felt252 address → compact secp256k1 signature) is real and verifiable
 * without a network.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  StarknetConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_STARKNET_HEADER,
  // Types
  type StarknetConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer
  RealStarknetSigner,
  generateStarknetKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  // felt252 address codec
  feltAddressFromPublicKey,
  normalizeFelt,
  isFelt,
  explorerBase,
  STARK_PRIME,
  type StarknetNetwork,
  type StarknetKeypair,
  type RealStarknetSignerConfig,
  type StarknetSignResult,
} from "./real-signer.js";

/**
 * @openagentpay/wallet-crossmint public entrypoint.
 *
 * Crossmint NFT-aware embedded EVM wallet connector: an agent wallet derived
 * deterministically from a project's `apiKey` + `projectId` signs EIP-712
 * EIP-3009 transferWithAuthorization (USDC on Base Sepolia). NFT-aware +
 * embedded; on-chain broadcast is behind a pluggable, offline-safe hook.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  CrossmintConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  CROSSMINT_PROTOCOL,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_EXPLORER,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  // Types
  type CrossmintConnectorConfig,
  type InstrumentStore,
  type Money,
} from "./connector.js";

export {
  // Real secp256k1 EIP-712 signer (no facilitator needed for offline signing)
  RealCrossmintSigner,
  generateCrossmintKeypair,
  deriveCrossmintPrivateKey,
  keypairFromPrivateKey,
  generateNonce,
  EIP3009_TYPES,
  type CrossmintKeypair,
  type RealCrossmintSignerConfig,
  type Eip3009Authorization,
  type Eip712Domain,
  type CrossmintSignedAuthorization,
} from "./real-signer.js";

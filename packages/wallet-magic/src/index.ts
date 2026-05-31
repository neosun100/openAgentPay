/**
 * @openagentpay/wallet-magic public entrypoint.
 *
 * Magic.link email-based EVM wallet connector. Implements the 5-method
 * WalletConnector contract using a real secp256k1 keypair derived in-process,
 * EIP-712 EIP-3009 signing via viem, and a pluggable on-chain broadcast hook.
 * Asset: USDC on Base Sepolia (6 decimals). Protocol: x402-v1.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  MagicConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  MAGIC_PROTOCOL,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_EXPLORER,
  BASE_SEPOLIA_USDC,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  // Types
  type MagicConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (in-process keygen + EIP-712 EIP-3009 signing)
  RealMagicSigner,
  generateMagicKeypair,
  keypairFromPrivateKey,
  generateNonce,
  isLikelyEmail,
  EIP3009_TYPES,
  type MagicKeypair,
  type RealMagicSignerConfig,
  type Eip3009Authorization,
  type Eip712Domain,
  type MagicSignedAuthorization,
} from "./real-signer.js";

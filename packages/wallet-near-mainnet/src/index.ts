/**
 * @openagentpay/wallet-near-mainnet public entrypoint.
 *
 * NEAR MAINNET WalletConnector — Ed25519 implicit + ".near" named accounts,
 * near-pay-v1, USDC (NEP-141) payment rail.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  NearMainnetConnector,
  DemoNearMainnetSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  NEAR_DECIMALS,
  USDC_DECIMALS,
  NEAR_USDC_MAINNET,
  // Types
  type NearMainnetConnectorConfig,
  type NearMainnetSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no near-api-js needed for signing)
  RealNearMainnetSigner,
  generateNearKeypair,
  keypairFromSeed,
  keypairFromSecretKey,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  isValidMainnetAccountId,
  IMPLICIT_ACCOUNT_RE,
  NAMED_ACCOUNT_RE,
  type NearKeypair,
  type RealNearMainnetSignerConfig,
} from "./real-signer.js";

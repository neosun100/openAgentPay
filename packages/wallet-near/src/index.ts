/**
 * @openagentpay/wallet-near public entrypoint.
 *
 * NEAR Protocol WalletConnector — Ed25519 implicit accounts, near-pay-v1.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  NearConnector,
  DemoNearSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  NEAR_DECIMALS,
  USDC_DECIMALS,
  // Types
  type NearConnectorConfig,
  type NearSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no near-api-js needed for signing)
  RealNearSigner,
  generateNearKeypair,
  keypairFromSeed,
  keypairFromSecretKey,
  canonicalTransferDescriptor,
  type NearKeypair,
  type RealNearSignerConfig,
} from "./real-signer.js";

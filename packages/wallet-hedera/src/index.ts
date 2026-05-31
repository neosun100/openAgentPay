/**
 * @openagentpay/wallet-hedera public entrypoint.
 *
 * Hedera Hashgraph WalletConnector: native HBAR + HTS USDC, Ed25519 signing,
 * "0.0.<num>" account-id identity. Non-EVM proof-of-abstraction #2.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  HederaConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  HTS_USDC_TOKEN_ID,
  // Types
  type HederaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no @hashgraph/sdk needed for signing)
  RealHederaSigner,
  generateHederaKeypair,
  keypairFromSeed,
  keypairFromDer,
  derivePrivateKeyDer,
  deriveMockAccountId,
  canonicalTransferDescriptor,
  HEDERA_ED25519_DER_PREFIX,
  HEDERA_ED25519_PUB_DER_PREFIX,
  type HederaKeypair,
  type RealHederaSignerConfig,
} from "./real-signer.js";

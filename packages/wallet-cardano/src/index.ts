/**
 * @openagentpay/wallet-cardano public entrypoint.
 *
 * Cardano (Shelley) WalletConnector — Ed25519 + blake2b-224 + bech32
 * "addr_test1…" enterprise addresses. Non-EVM proof that the 5-method
 * WalletConnector contract holds across the eUTxO model.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  CardanoConnector,
  DemoCardanoSigner,
  RealCardanoSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_CARDANO_HEADER,
  // Types
  type CardanoConnectorConfig,
  type CardanoSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no cardano-serialization-lib needed for signing)
  generateCardanoKeypair,
  keypairFromSeed,
  keypairFromHex,
  paymentKeyHash,
  enterpriseAddress,
  decodeEnterpriseAddress,
  canonicalTransferDescriptor,
  ENTERPRISE_TESTNET_HEADER,
  ENTERPRISE_MAINNET_HEADER,
  TESTNET_HRP,
  MAINNET_HRP,
  type CardanoKeypair,
  type CardanoNetwork,
  type RealCardanoSignerConfig,
} from "./real-signer.js";

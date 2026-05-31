/**
 * @openagentpay/wallet-aptos public entrypoint.
 *
 * Provides BOTH a ProtocolAdapter (for parsing Aptos Pay 402 responses)
 * and a WalletConnector (for executing the payment). They're packaged
 * together because both halves are required to use Aptos — no other
 * existing OpenAgentPay package adapts the Aptos Pay protocol.
 *
 * @license Apache-2.0
 */

export {
  // Protocol layer
  AptosPayProtocolAdapter,
  parseAptosPayUrl,
  buildAptosPayUrl,
  // Wallet layer
  AptosConnector,
  DemoAptosSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_APTOS_HEADER,
  APT_COIN_TYPE,
  // Types
  type AptosPayAdapterConfig,
  type AptosPayUrlFields,
  type AptosConnectorConfig,
  type AptosSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no @aptos-labs/ts-sdk needed for signing)
  RealAptosSigner,
  generateAptosKeypair,
  keypairFromSeed,
  keypairFromPrivateKeyHex,
  authKeyFromPublicKey,
  canonicalTransferDescriptor,
  type AptosKeypair,
  type RealAptosSignerConfig,
} from "./real-signer.js";

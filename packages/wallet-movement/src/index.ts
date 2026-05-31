/**
 * @openagentpay/wallet-movement public entrypoint.
 *
 * Provides BOTH a ProtocolAdapter (for parsing Movement Pay 402 responses)
 * and a WalletConnector (for executing the payment). They're packaged
 * together because both halves are required to use Movement — no other
 * existing OpenAgentPay package adapts the Movement Pay protocol.
 *
 * Movement is an Aptos-compatible Move-VM L2, so the connector mirrors
 * wallet-aptos exactly (Ed25519 / sha3_256 single-key auth) with Movement
 * branding (MOVE native gas token, movement: URL scheme).
 *
 * @license Apache-2.0
 */

export {
  // Protocol layer
  MovementPayProtocolAdapter,
  parseMovementPayUrl,
  buildMovementPayUrl,
  // Wallet layer
  MovementConnector,
  DemoMovementSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_MOVEMENT_HEADER,
  MOVE_COIN_TYPE,
  // Types
  type MovementPayAdapterConfig,
  type MovementPayUrlFields,
  type MovementConnectorConfig,
  type MovementSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no Movement/Aptos SDK needed for signing)
  RealMovementSigner,
  generateMovementKeypair,
  keypairFromSeed,
  keypairFromPrivateKeyHex,
  authKeyFromPublicKey,
  canonicalTransferDescriptor,
  type MovementKeypair,
  type RealMovementSignerConfig,
} from "./real-signer.js";

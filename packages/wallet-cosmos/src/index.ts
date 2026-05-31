/**
 * @openagentpay/wallet-cosmos public entrypoint.
 *
 * Cosmos (IBC) WalletConnector — secp256k1 + BIP39/BIP44 + bech32. Non-EVM
 * proof that the 5-method WalletConnector contract holds across the Cosmos SDK
 * chain model.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  CosmosConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  ATOM_DENOM,
  USDC_DENOM,
  COSMOS_BECH32_PREFIX,
  // Types
  type CosmosConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no @cosmjs/* needed for signing)
  RealCosmosSigner,
  generateCosmosWallet,
  generateCosmosKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  COSMOS_COIN_TYPE,
  COSMOS_HD_PATH,
  type CosmosWallet,
  type CosmosKeypair,
  type RealCosmosSignerConfig,
} from "./real-signer.js";

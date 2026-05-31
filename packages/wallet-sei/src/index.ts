/**
 * @openagentpay/wallet-sei public entrypoint.
 *
 * Sei WalletConnector — secp256k1 + BIP39/BIP44 + bech32 ("sei1…"). A
 * Cosmos-SDK chain proving the 5-method WalletConnector contract holds across
 * the Cosmos chain family.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  SeiConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  SEI_DENOM,
  USDC_DENOM,
  SEI_BECH32_PREFIX,
  // Types
  type SeiConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no @cosmjs/* needed for signing)
  RealSeiSigner,
  generateSeiWallet,
  generateSeiKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  SEI_COIN_TYPE,
  SEI_HD_PATH,
  type SeiWallet,
  type SeiKeypair,
  type RealSeiSignerConfig,
} from "./real-signer.js";

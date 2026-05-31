/**
 * @openagentpay/wallet-celestia public entrypoint.
 *
 * Celestia WalletConnector — secp256k1 + BIP39/BIP44 + bech32 ("celestia1…").
 * Non-EVM proof that the 5-method WalletConnector contract holds across the
 * Celestia modular-DA chain (Cosmos SDK).
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  CelestiaConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  TIA_NATIVE_DENOM,
  CELESTIA_BECH32_PREFIX,
  // Types
  type CelestiaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no @cosmjs/* needed for signing)
  RealCelestiaSigner,
  generateCelestiaWallet,
  generateCelestiaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  CELESTIA_COIN_TYPE,
  CELESTIA_HD_PATH,
  TIA_DENOM,
  type CelestiaWallet,
  type CelestiaKeypair,
  type RealCelestiaSignerConfig,
} from "./real-signer.js";

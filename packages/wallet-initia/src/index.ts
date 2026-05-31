/**
 * @openagentpay/wallet-initia public entrypoint.
 *
 * Initia WalletConnector — secp256k1 + BIP39/BIP44 + bech32 ("init1…"). Non-EVM
 * proof that the 5-method WalletConnector contract holds across the Cosmos SDK
 * chain model on the Initia interwoven-rollup L1.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  InitiaConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  INIT_DENOM,
  USDC_DENOM,
  INITIA_BECH32_PREFIX,
  // Types
  type InitiaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no @initia/* needed for signing)
  RealInitiaSigner,
  generateInitiaWallet,
  generateInitiaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  canonicalTransferDescriptor,
  INITIA_COIN_TYPE,
  INITIA_HD_PATH,
  type InitiaWallet,
  type InitiaKeypair,
  type RealInitiaSignerConfig,
} from "./real-signer.js";

/**
 * @openagentpay/wallet-kaspa public entrypoint.
 *
 * Kaspa WalletConnector — secp256k1 + BIP39/BIP44 + Kaspa cashaddr ("kaspatest:…").
 * Non-EVM proof that the 5-method WalletConnector contract holds across the
 * Kaspa BlockDAG chain model.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  KaspaConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  KAS_DECIMALS,
  SOMPI_DENOM,
  KASPA_HRP,
  // Types
  type KaspaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no kaspa-wasm needed for signing)
  RealKaspaSigner,
  generateKaspaWallet,
  generateKaspaKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  decodeAddress,
  canonicalTransferDescriptor,
  KASPA_COIN_TYPE,
  KASPA_HD_PATH,
  KASPA_MAINNET_HRP,
  KASPA_ADDR_VERSION,
  type KaspaWallet,
  type KaspaKeypair,
  type RealKaspaSignerConfig,
} from "./real-signer.js";

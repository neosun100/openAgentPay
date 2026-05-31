/**
 * @openagentpay/wallet-injective public entrypoint.
 *
 * Injective WalletConnector — Ethermint secp256k1 + BIP39/BIP44 (coin type 60)
 * + keccak256 + bech32("inj"). Proof that the 5-method WalletConnector
 * contract holds for a Cosmos-SDK chain that uses Ethereum-style account keys.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  InjectiveConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  INJ_DENOM,
  USDT_DENOM,
  INJECTIVE_BECH32_PREFIX,
  // Types
  type InjectiveConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ethermint secp256k1 signer (no @injectivelabs/* needed for signing)
  RealInjectiveSigner,
  generateInjectiveWallet,
  generateInjectiveKeypair,
  keypairFromMnemonic,
  addressFromPublicKey,
  ethAddressBytes,
  toEip55,
  canonicalTransferDescriptor,
  INJECTIVE_COIN_TYPE,
  INJECTIVE_HD_PATH,
  type InjectiveWallet,
  type InjectiveKeypair,
  type RealInjectiveSignerConfig,
} from "./real-signer.js";

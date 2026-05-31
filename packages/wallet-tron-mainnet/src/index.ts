/**
 * @openagentpay/wallet-tron-mainnet public entrypoint.
 *
 * A WalletConnector for the TRON MAINNET chain (TRC-20 USDT + native TRX),
 * backed by a real secp256k1 signer with base58check address derivation.
 * Broadcast stays behind the signer's pluggable `submit` hook so signing runs
 * fully offline.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  TronMainnetConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  USDT_TRC20_MAINNET,
  // Types
  type TronMainnetConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (no tronweb needed for signing)
  RealTronMainnetSigner,
  generateTronKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  // Address codec
  base58CheckEncode,
  base58CheckDecode,
  pubkeyToAddressBytes,
  addressToHex,
  TRON_ADDRESS_PREFIX,
  type TronKeypair,
  type RealTronMainnetSignerConfig,
  type TronSignResult,
} from "./real-signer.js";

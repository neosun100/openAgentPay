/**
 * @openagentpay/wallet-dogecoin public entrypoint.
 *
 * Provides a WalletConnector for Dogecoin — legacy P2PKH UTXO, secp256k1,
 * base58check addresses. No SegWit (Doge never adopted it). Signing is fully
 * real + offline; on-chain broadcast is deferred behind the signer's pluggable
 * `submit` hook.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  DogecoinConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_DOGECOIN_HEADER,
  // Types
  type DogecoinConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (production-shaped — no doge libs needed for signing)
  RealDogecoinSigner,
  generateDogecoinKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  // Address codec
  encodeP2PKHAddress,
  decodeP2PKHAddress,
  base58CheckEncode,
  base58CheckDecode,
  hash160,
  dsha256,
  p2pkhVersionByte,
  type DogecoinKeypair,
  type DogecoinNetwork,
  type RealDogecoinSignerConfig,
  type DogecoinSignResult,
} from "./real-signer.js";

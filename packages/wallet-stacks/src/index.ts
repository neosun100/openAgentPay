/**
 * @openagentpay/wallet-stacks public entrypoint.
 *
 * A WalletConnector for Stacks (Bitcoin L2, testnet by default), backed by a
 * real secp256k1 signer with native c32check address derivation. Broadcast
 * stays behind the signer's pluggable `submit` hook so signing runs fully
 * offline — the cryptographic identity (keypair → ST… address → compact
 * secp256k1 signature) is entirely real and verifiable without a network.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  StacksConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_STACKS_HEADER,
  // Types
  type StacksConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer
  RealStacksSigner,
  generateStacksKeypair,
  generateStacksMnemonic,
  keypairFromPrivateKey,
  keypairFromHex,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  // c32check address codec
  c32address,
  c32addressDecode,
  c32checkEncode,
  c32checkDecode,
  c32encode,
  c32decode,
  hash160,
  dsha256,
  addressPrefixFor,
  C32_ALPHABET,
  STACKS_VERSION,
  type StacksNetwork,
  type StacksKeypair,
  type RealStacksSignerConfig,
  type StacksSignResult,
  type C32CheckDecoded,
} from "./real-signer.js";

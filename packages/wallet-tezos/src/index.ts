/**
 * @openagentpay/wallet-tezos public entrypoint.
 *
 * Provides BOTH a ProtocolAdapter (Tezos Pay URI → PaymentRequest) and a
 * WalletConnector (Ed25519 tz1 signing + settlement). Packaged together because
 * both halves are required to pay on Tezos.
 *
 * @license Apache-2.0
 */

export {
  // Protocol layer
  TezosPayProtocolAdapter,
  parseTezosPayUri,
  buildTezosPayUri,
  // Wallet layer
  TezosConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_TEZOS_HEADER,
  XTZ_DECIMALS,
  // Types
  type TezosPayAdapterConfig,
  type TezosPayUriFields,
  type TezosConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer (production-shaped — no taquito needed for signing)
  RealTezosSigner,
  generateTezosKeypair,
  keypairFromSeed,
  keypairFromSecret,
  canonicalTransferDescriptor,
  // Address / key codec
  base58CheckEncode,
  base58CheckDecode,
  blake2b160,
  encodeTz1Address,
  encodeEdskSeed,
  encodeEdpk,
  encodeEdsig,
  decodeEdskSeed,
  decodeEdsig,
  isValidTz1Address,
  // Prefixes
  PREFIX_TZ1,
  PREFIX_EDSK_SEED,
  PREFIX_EDPK,
  PREFIX_EDSIG,
  type TezosKeypair,
  type RealTezosSignerConfig,
  type TezosSignResult,
} from "./real-signer.js";

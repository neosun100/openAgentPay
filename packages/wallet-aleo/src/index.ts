/**
 * @openagentpay/wallet-aleo public entrypoint.
 *
 * A WalletConnector for Aleo (privacy-focused L1, testnet by default), backed
 * by a real ed25519 signer with a bech32m "aleo1…" address codec. Broadcast
 * stays behind the signer's pluggable `submit` hook so signing runs fully
 * offline — the cryptographic identity (keypair → aleo1… address → ed25519
 * signature) is entirely real and verifiable without a network.
 *
 * NOTE (testnet-shaped approximation): Aleo's production crypto is Schnorr over
 * BLS12-377 + Poseidon + zkSNARK accounts. To stay offline + dependency-light
 * we use an ed25519 identity and derive the address as
 * bech32m("aleo", sha256(pubkey)[0..20]). The WalletConnector contract +
 * conformance suite are what matter; swap the signer for production.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  AleoConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_ALEO_HEADER,
  // Types
  type AleoConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real ed25519 signer
  RealAleoSigner,
  generateAleoKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  canonicalTransferDescriptor,
  // bech32m address codec
  aleoAddressEncode,
  aleoAddressDecode,
  addressProgram,
  ALEO_HRP,
  ALEO_ADDR_BYTES,
  type AleoNetwork,
  type AleoKeypair,
  type RealAleoSignerConfig,
  type AleoSignResult,
  type AleoAddressDecoded,
} from "./real-signer.js";

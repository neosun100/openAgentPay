/**
 * @openagentpay/wallet-monero public entrypoint.
 *
 * Monero (XMR) WalletConnector — privacy chain, view-key identity model.
 *
 * Scope note: real Monero confidentiality (ring signatures, RingCT, stealth
 * addresses, bulletproofs) is OUT OF SCOPE. This package implements the
 * identity + authorization layer: dual Ed25519 (spend + view) keypairs, a
 * checksummed base58 address, and a real verifiable Ed25519 signature over the
 * canonical transfer descriptor. Broadcast is pluggable + offline-safe.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  MoneroConnector,
  MemoryInstrumentStore,
  createMoneroConnector,
  // monero: URI helpers
  parseMoneroUri,
  buildMoneroUri,
  xmrToAtomic,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_MONERO_HEADER,
  XMR_DECIMALS,
  // Types
  type MoneroConnectorConfig,
  type MoneroSigner,
  type MoneroUriFields,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real Ed25519 signer + Monero address codec
  RealMoneroSigner,
  generateMoneroKeypair,
  keypairFromSecrets,
  keypairFromHex,
  encodeMoneroAddress,
  decodeMoneroAddress,
  isValidMoneroAddress,
  canonicalTransferDescriptor,
  MONERO_NETWORK_BYTE,
  type MoneroKeypair,
  type MoneroNetwork,
  type RealMoneroSignerConfig,
  type DecodedMoneroAddress,
} from "./real-signer.js";

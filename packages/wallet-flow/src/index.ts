/**
 * @openagentpay/wallet-flow public entrypoint.
 *
 * Flow (Cadence) WalletConnector — secp256k1 signing over Flow's 8-byte
 * chain-assigned account addresses, with a pluggable, offline-safe broadcast.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  FlowConnector,
  MemoryInstrumentStore,
  RealFlowSigner,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  FLOW_TOKEN_CONTRACT,
  FLOW_USDC_CONTRACT,
  // Types
  type FlowConnectorConfig,
  type FlowSigner,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer + keypair / address helpers
  generateFlowKeypair,
  keypairFromPrivateKey,
  keypairFromHex,
  pubkeyToMockAddress,
  isValidFlowAddress,
  normalizeFlowAddress,
  canonicalTransferDescriptor,
  FLOW_ADDRESS_BYTES,
  FLOW_ADDRESS_RE,
  type FlowKeypair,
  type RealFlowSignerConfig,
} from "./real-signer.js";

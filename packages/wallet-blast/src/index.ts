/**
 * @openagentpay/wallet-blast public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  blastSepoliaChain,
  BLAST_SEPOLIA_CHAIN_ID,
  BLAST_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  BlastTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type BlastTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  BlastSepoliaConnector,
  WALLET_PROVIDER_ID,
  BLAST_PROTOCOL,
  MemoryInstrumentStore,
  type BlastSepoliaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

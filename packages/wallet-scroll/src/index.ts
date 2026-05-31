/**
 * @openagentpay/wallet-scroll public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  scrollSepoliaChain,
  SCROLL_SEPOLIA_CHAIN_ID,
  SCROLL_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  ScrollTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type ScrollTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  ScrollSepoliaConnector,
  WALLET_PROVIDER_ID,
  SCROLL_PROTOCOL,
  MemoryInstrumentStore,
  type ScrollSepoliaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

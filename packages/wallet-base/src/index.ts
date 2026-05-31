/**
 * @openagentpay/wallet-base public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  baseSepoliaChain,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  BaseTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type BaseTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  BaseSepoliaConnector,
  WALLET_PROVIDER_ID,
  BASE_PROTOCOL,
  MemoryInstrumentStore,
  type BaseSepoliaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

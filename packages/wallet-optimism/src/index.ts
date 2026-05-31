/**
 * @openagentpay/wallet-optimism public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  optimismSepoliaChain,
  OP_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  OptimismTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  generateEvmPrivateKey,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type OptimismTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  OptimismConnector,
  WALLET_PROVIDER_ID,
  OPTIMISM_PROTOCOL,
  MemoryInstrumentStore,
  type OptimismConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

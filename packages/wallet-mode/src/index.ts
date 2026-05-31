/**
 * @openagentpay/wallet-mode public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  modeSepoliaChain,
  MODE_SEPOLIA_CHAIN_ID,
  MODE_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  ModeTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type ModeTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  ModeSepoliaConnector,
  WALLET_PROVIDER_ID,
  MODE_PROTOCOL,
  MODE_CAIP2,
  MemoryInstrumentStore,
  type ModeSepoliaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

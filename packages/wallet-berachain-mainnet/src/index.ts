/**
 * @openagentpay/wallet-berachain-mainnet public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  berachainMainnet,
  BERACHAIN_MAINNET_CHAIN_ID,
  BERACHAIN_MAINNET_STABLE,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  BeraTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type BeraTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  BerachainMainnetConnector,
  WALLET_PROVIDER_ID,
  BERA_PROTOCOL,
  BERA_CAIP2,
  BERA_STABLE_SYMBOL,
  MemoryInstrumentStore,
  type BerachainMainnetConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

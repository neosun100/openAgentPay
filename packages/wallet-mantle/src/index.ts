/**
 * @openagentpay/wallet-mantle public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  mantleSepoliaChain,
  MANTLE_SEPOLIA_CHAIN_ID,
  MANTLE_SEPOLIA_RPC_URL,
  MANTLE_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  MantleTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type MantleTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  MantleSepoliaConnector,
  WALLET_PROVIDER_ID,
  MANTLE_PROTOCOL,
  MemoryInstrumentStore,
  type MantleSepoliaConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

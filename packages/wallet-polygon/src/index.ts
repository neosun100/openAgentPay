/**
 * @openagentpay/wallet-polygon public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  polygonAmoyTestnet,
  POLYGON_AMOY_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  PolygonAmoyTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type PolygonAmoyTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  PolygonAmoyConnector,
  WALLET_PROVIDER_ID,
  POLYGON_PROTOCOL,
  MemoryInstrumentStore,
  type PolygonAmoyConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

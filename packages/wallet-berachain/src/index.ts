/**
 * @openagentpay/wallet-berachain public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  berachainBartioChain,
  BERACHAIN_BARTIO_CHAIN_ID,
  BERACHAIN_BARTIO_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  BerachainTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type BerachainTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  BerachainConnector,
  WALLET_PROVIDER_ID,
  BERACHAIN_PROTOCOL,
  MemoryInstrumentStore,
  type BerachainConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

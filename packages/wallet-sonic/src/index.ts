/**
 * @openagentpay/wallet-sonic public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  sonicBlazeChain,
  SONIC_BLAZE_CHAIN_ID,
  SONIC_BLAZE_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  SonicTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type SonicTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  SonicConnector,
  WALLET_PROVIDER_ID,
  SONIC_PROTOCOL,
  MemoryInstrumentStore,
  type SonicConnectorConfig,
  type SonicBroadcastMode,
  type InstrumentStore,
} from "./connector.js";

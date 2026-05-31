/**
 * @openagentpay/wallet-ronin public entrypoint.
 *
 * Ronin (Axie Infinity) self-custodial EVM wallet connector. x402 / EIP-3009
 * transferWithAuthorization against USDC on Ronin Saigon testnet (chainId 2021).
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  roninSaigonChain,
  RONIN_SAIGON_CHAIN_ID,
  RONIN_SAIGON_RPC,
  RONIN_SAIGON_EXPLORER,
  RONIN_SAIGON_USDC,
  toRoninDisplay,
  fromRoninDisplay,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  RoninTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type RoninTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  RoninSaigonConnector,
  WALLET_PROVIDER_ID,
  RONIN_PROTOCOL,
  MemoryInstrumentStore,
  MockBroadcaster,
  type Broadcaster,
  type RoninSaigonConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

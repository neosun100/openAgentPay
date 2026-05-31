/**
 * @openagentpay/wallet-zksync — public surface.
 * @license Apache-2.0
 */

export {
  ZkSyncConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  ZKSYNC_PROTOCOL,
  type ZkSyncConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  ZkSyncTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type ZkSyncTokenClientConfig,
} from "./token-client.js";

export {
  zksyncSepolia,
  ZKSYNC_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

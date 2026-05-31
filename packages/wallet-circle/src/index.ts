/**
 * @openagentpay/wallet-circle public entrypoint.
 *
 * Circle Programmable Wallets connector — developer-controlled EVM wallets,
 * USDC-native + gas-station, settling x402-v1 via EIP-3009
 * transferWithAuthorization across Base Sepolia / Polygon Amoy / ETH Sepolia.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  CircleConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  CIRCLE_PROTOCOL,
  // Types
  type CircleConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (developer-controlled key derivation)
  RealCircleSigner,
  deriveCircleKeypair,
  generateEntitySecret,
  generateNonce,
  ensureHex32,
  EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
  type CircleKeypair,
  type RealCircleSignerConfig,
  type CircleBroadcastInput,
  type CircleBroadcastResult,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./real-signer.js";

export {
  // Chain registry
  CIRCLE_CHAINS,
  resolveCircleChain,
  txExplorerUrl,
  type CircleNetwork,
  type CircleChainInfo,
} from "./chain.js";

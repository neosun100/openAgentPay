/**
 * @openagentpay/wallet-fireblocks — public surface.
 *
 * Fireblocks institutional MPC-custody wallet connector. EVM EIP-3009 over
 * USDC on Base Sepolia, policy-engine (TAP) governed.
 *
 * @license Apache-2.0
 */

export {
  FireblocksConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  FIREBLOCKS_PROTOCOL,
  NETWORK_NAME,
  type FireblocksConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  RealFireblocksSigner,
  generateFireblocksKeypair,
  keypairFromPrivateKey,
  deriveFireblocksKeypair,
  generateNonce,
  ensureHex32,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_EXPLORER_TX,
  EIP712_TRANSFER_WITH_AUTHORIZATION_TYPES,
  type FireblocksKeypair,
  type RealFireblocksSignerConfig,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type FireblocksSubmitInput,
  type FireblocksSubmitResult,
} from "./real-signer.js";

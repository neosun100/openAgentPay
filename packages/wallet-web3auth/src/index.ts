/**
 * @openagentpay/wallet-web3auth public entrypoint.
 *
 * Web3Auth social-login MPC EVM wallet connector. Implements the 5-method
 * WalletConnector contract using a real secp256k1 keypair derived in-process,
 * EIP-712 EIP-3009 signing via viem, and a pluggable on-chain broadcast hook.
 * Wallet identity is keyed to a social login (loginProvider + verifierId).
 * Asset: USDC on Base Sepolia (6 decimals). Protocol: x402-v1.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  Web3AuthConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  WEB3AUTH_PROTOCOL,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_EXPLORER,
  BASE_SEPOLIA_USDC,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  // Types
  type Web3AuthConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer (in-process keygen + EIP-712 EIP-3009 signing)
  RealWeb3AuthSigner,
  generateWeb3AuthKeypair,
  keypairFromPrivateKey,
  generateNonce,
  WEB3AUTH_LOGIN_PROVIDERS,
  EIP3009_TYPES,
  type Web3AuthKeypair,
  type RealWeb3AuthSignerConfig,
  type SocialLogin,
  type Eip3009Authorization,
  type Eip712Domain,
  type Web3AuthSignedAuthorization,
} from "./real-signer.js";

/**
 * @openagentpay/wallet-stripe-privy public entrypoint.
 *
 * Stripe Privy managed embedded-wallet connector (EVM secp256k1 + EIP-3009,
 * x402-v1) on Base Sepolia. Closes AgentCore Path-D parity for non-CDP managed
 * wallets — see docs/POSITIONING.md.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  StripePrivyConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  STRIPE_PRIVY_PROTOCOL,
  // Types
  type StripePrivyConnectorConfig,
  type InstrumentStore,
  type SubmitHook,
  type BalanceReader,
} from "./connector.js";

export {
  // Managed embedded-wallet layer (Privy-shaped)
  StripePrivyEmbeddedWallet,
  createEmbeddedWallet,
  generateEmbeddedWalletKey,
  generateNonce,
  txExplorerUrl,
  // EIP-712 / EIP-3009
  EIP712_TYPES,
  // Base Sepolia constants
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_EXPLORER,
  // Types
  type StripePrivyConfig,
  type PrivyEmbeddedWallet,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./embedded-wallet.js";

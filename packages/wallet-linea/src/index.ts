/**
 * @openagentpay/wallet-linea public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  lineaSepoliaTestnet,
  LINEA_SEPOLIA_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// WalletConnector (high-level, OpenAgentPay interface) + token client
export {
  LineaConnector,
  DefaultLineaTokenClient,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  LINEA_PROTOCOL,
  EIP712_TYPES,
  type LineaConnectorConfig,
  type LineaTokenClient,
  type InstrumentStore,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./connector.js";

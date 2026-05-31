/**
 * @openagentpay/wallet-sui — public surface.
 * @license Apache-2.0
 */

export {
  SuiConnector,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_SUI_HEADER,
  SUI_COIN_TYPE,
  SUI_USDC_TESTNET,
  type SuiSigner,
  type SuiConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  RealSuiSigner,
  generateSuiKeypair,
  keypairFromSeed,
  keypairFromSuiPrivateKey,
  encodeSuiPrivateKey,
  suiAddressFromPublicKey,
  canonicalTransferDescriptor,
  SUI_ED25519_FLAG,
  SUI_PRIVATE_KEY_HRP,
  type SuiKeypair,
  type RealSuiSignerConfig,
} from "./real-signer.js";

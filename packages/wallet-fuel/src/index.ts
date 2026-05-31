/**
 * @openagentpay/wallet-fuel public entrypoint.
 *
 * A WalletConnector for Fuel (FuelVM, testnet by default), backed by a real
 * secp256k1 signer with native b256 address derivation (sha256 of the raw
 * 64-byte public key). Broadcast stays behind the signer's pluggable `submit`
 * hook so signing runs fully offline — the cryptographic identity (keypair →
 * b256 address → compact secp256k1 signature over a sha256 digest) is entirely
 * real and verifiable without a network.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  FuelConnector,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_FUEL_HEADER,
  FUEL_USDC_ASSET_ID,
  // Types
  type FuelConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 signer
  RealFuelSigner,
  generateFuelKeypair,
  generateFuelMnemonic,
  keypairFromPrivateKey,
  keypairFromHex,
  keypairFromMnemonic,
  canonicalTransferDescriptor,
  // b256 address codec + derivation
  isB256,
  toB256,
  fromB256,
  fuelRawPublicKey,
  fuelAddressFromPublicKey,
  // Constants
  FUEL_BASE_ASSET_ID,
  FUEL_ETH_DECIMALS,
  type FuelNetwork,
  type FuelKeypair,
  type RealFuelSignerConfig,
  type FuelSignResult,
} from "./real-signer.js";

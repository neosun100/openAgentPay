/**
 * @openagentpay/wallet-zerodev public entrypoint.
 *
 * ZeroDev ERC-4337 smart-account connector: an owner secp256k1 EOA authorizes
 * UserOperations executed by a counterfactual smart account that holds funds,
 * enforces on-chain spending limits, and can have gas sponsored by a paymaster.
 *
 * @license Apache-2.0
 */

export {
  // Wallet layer
  ZeroDevConnector,
  MemoryInstrumentStore,
  // Constants
  WALLET_PROVIDER_ID,
  ZERODEV_PROTOCOL,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_CHAIN_ID,
  // Types
  type ZeroDevConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  // Real secp256k1 ERC-4337 signer (no bundler needed for offline signing)
  RealZeroDevSigner,
  generateZeroDevOwner,
  ownerFromPrivateKey,
  deriveSmartAccountAddress,
  canonicalUserOpDescriptor,
  userOpHash,
  ENTRYPOINT_V07,
  type ZeroDevOwnerKeypair,
  type RealZeroDevSignerConfig,
  type UserOpDescriptor,
} from "./real-signer.js";

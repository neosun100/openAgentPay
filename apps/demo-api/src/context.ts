/**
 * Application context — singleton wiring for the demo API.
 *
 * Now supports BOTH connectors side-by-side (path D hybrid):
 *   - HashKey Chain (self-custodial EVM, Asia, MockUSDC)
 *   - Coinbase CDP V2 (managed EVM, NA, Circle USDC on Base Sepolia)
 *
 * Both register into the same PaymentManager. Handlers route requests by
 * the `walletProvider` query/body parameter from the UI dropdown.
 *
 * Two modes:
 *   1. Local dev: reads .env.local
 *   2. Lambda:    reads HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN
 *                 (CDP creds via env vars from Lambda config)
 *
 * @license Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  DynamoDBSessionManager,
  type SessionManager,
  type UserId,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";
import {
  HashKeyChainConnector,
  HashKeyChainTokenClient,
  MemoryInstrumentStore as HashKeyMemoryInstrumentStore,
  hashkeyChainTestnet,
} from "@openagentpay/wallet-hashkey";
import {
  CoinbaseCDPConnector,
  MemoryInstrumentStore as CdpMemoryInstrumentStore,
  BASE_SEPOLIA_CHAIN,
  BASE_SEPOLIA_USDC_ADDRESS,
} from "@openagentpay/wallet-coinbase-cdp";
import {
  GovernanceManager,
  InMemoryAuditSink,
  InMemoryPolicyEngine,
  StaticSanctionsChecker,
  DEMO_SANCTIONS_LIST,
  DynamoDBAuditSink,
  velocityLimit,
  amountThreshold,
  type AuditEvent,
  type AuditSink,
} from "@openagentpay/governance";

// ----------------------------------------------------------------------------
//  .env.local loader (zero deps, local dev only)
// ----------------------------------------------------------------------------
function loadDotenvLocal(rootDir: string): void {
  const envPath = join(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(dir, ".env.local")) ||
      existsSync(join(dir, "pnpm-workspace.yaml"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ----------------------------------------------------------------------------
//  Secrets Manager loader (Lambda only)
// ----------------------------------------------------------------------------
async function loadFromSecretsManager(secretArn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const client = new SecretsManagerClient({});
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const resp = await client.send(cmd);
  if (!resp.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }
  const raw = resp.SecretString.trim();
  if (raw.startsWith("{")) {
    const obj = JSON.parse(raw) as {
      privateKey?: string;
      HASHKEY_TESTNET_AGENT_PRIVATE_KEY?: string;
    };
    return (
      obj.privateKey ?? obj.HASHKEY_TESTNET_AGENT_PRIVATE_KEY ?? raw
    ).trim();
  }
  return raw;
}

// ----------------------------------------------------------------------------
//  ConnectorBundle — per-wallet metadata bundled with the connector
// ----------------------------------------------------------------------------
export interface ConnectorBundle {
  readonly walletProvider: WalletProviderId;
  readonly displayName: string;
  readonly connector: WalletConnector;
  /** Address explorer URL builder */
  readonly addressExplorer: (addr: string) => string;
  /** Tx explorer URL builder */
  readonly txExplorer: (hash: string) => string;
  readonly chainName: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly tokenLabel: string; // "USDC (mock)" or "USDC (Circle official)"
  readonly agentAddress: string;
}

// ----------------------------------------------------------------------------
//  Public context
// ----------------------------------------------------------------------------
export interface AppContext {
  readonly manager: InMemoryPaymentManager;
  readonly sessionManager: SessionManager;
  readonly demoUserId: UserId;
  readonly connectors: Map<WalletProviderId, ConnectorBundle>;
  /** Default wallet provider (HashKey for backwards compat with old UI) */
  readonly defaultProvider: WalletProviderId;
  /** Layer 3+5+7 Guardrail (Policy, Compliance, Audit). */
  readonly governance: GovernanceManager;
  /** Underlying audit sink — exposed so the API can list recent events. */
  readonly auditSink: InMemoryAuditSink;
  /** Optional DynamoDB persistent sink — set when AUDIT_TABLE_NAME env var present. */
  readonly dynamoSink?: DynamoDBAuditSink;
  /** Active policies — exposed so the API can describe what's enforced. */
  readonly policyDescriptions: ReadonlyArray<{ readonly name: string }>;
  /** Recent payments cache — used by velocity policies for sliding-window lookback. */
  readonly recentPayments: import("@openagentpay/governance").RecentPaymentRecord[];
}

let _ctx: AppContext | null = null;
let _ctxPromise: Promise<AppContext> | null = null;

// ----------------------------------------------------------------------------
//  HashKey bundle builder
// ----------------------------------------------------------------------------
async function buildHashKeyBundle(): Promise<ConnectorBundle | null> {
  let pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  const secretArn =
    process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN"];
  if (!pk && secretArn) {
    pk = await loadFromSecretsManager(secretArn);
  }
  if (!pk) return null; // graceful skip if not configured

  const tokenAddress = process.env["HASHKEY_USDC_ADDRESS"];
  if (!tokenAddress) {
    console.warn("HashKey skipped: HASHKEY_USDC_ADDRESS missing");
    return null;
  }
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  const rpcUrl = process.env["HASHKEY_RPC_URL"];

  const store = new HashKeyMemoryInstrumentStore();
  const tokenClient = new HashKeyChainTokenClient({
    tokenAddress: tokenAddress as `0x${string}`,
    chain: hashkeyChainTestnet,
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
  });
  const connector = new HashKeyChainConnector({
    privateKey: pk as `0x${string}`,
    tokenAddress: tokenAddress as `0x${string}`,
    instrumentStore: store,
    tokenClient,
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
  });

  const explorer = hashkeyChainTestnet.blockExplorers?.default?.url ?? "";
  return {
    walletProvider: connector.getCapabilities().walletProvider,
    displayName: connector.getCapabilities().displayName,
    connector,
    addressExplorer: (addr) => `${explorer}/address/${addr}`,
    txExplorer: (hash) => `${explorer}/tx/${hash}`,
    chainName: hashkeyChainTestnet.name,
    chainId: hashkeyChainTestnet.id,
    tokenAddress,
    tokenDecimals: 6,
    tokenLabel: "MockUSDC (HashKey Chain)",
    agentAddress: connector.agentAddress,
  };
}

// ----------------------------------------------------------------------------
//  Coinbase CDP bundle builder
// ----------------------------------------------------------------------------
async function buildCoinbaseCdpBundle(): Promise<ConnectorBundle | null> {
  const apiKeyId = process.env["COINBASE_CDP_API_KEY_ID"];
  let apiKeySecret = process.env["COINBASE_CDP_API_KEY_SECRET"];
  let walletSecret = process.env["COINBASE_CDP_WALLET_SECRET"];

  // Lambda mode: load secrets from Secrets Manager via ARN
  const apiKeyArn = process.env["COINBASE_CDP_API_KEY_SECRET_ARN"];
  const walletArn = process.env["COINBASE_CDP_WALLET_SECRET_ARN"];
  if (!apiKeySecret && apiKeyArn) {
    apiKeySecret = await loadFromSecretsManager(apiKeyArn);
  }
  if (!walletSecret && walletArn) {
    walletSecret = await loadFromSecretsManager(walletArn);
  }

  const agentAddress =
    process.env["COINBASE_CDP_AGENT_ADDRESS"] ??
    "0x851C03756D5e9e057cb518C1B3cd47f628a0Dca7";
  const recipientAddress = process.env["COINBASE_CDP_RECIPIENT_ADDRESS"];

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    return null; // CDP not configured — skip silently
  }

  const store = new CdpMemoryInstrumentStore();
  const connector = new CoinbaseCDPConnector({
    apiKeyId,
    apiKeySecret,
    walletSecret,
    agentAddress: agentAddress as `0x${string}`,
    ...(recipientAddress
      ? { recipientAddress: recipientAddress as `0x${string}` }
      : {}),
    instrumentStore: store,
  });

  const explorer = BASE_SEPOLIA_CHAIN.blockExplorers?.default?.url ?? "";
  return {
    walletProvider: connector.getCapabilities().walletProvider,
    displayName: connector.getCapabilities().displayName,
    connector,
    addressExplorer: (addr) => `${explorer}/address/${addr}`,
    txExplorer: (hash) => `${explorer}/tx/${hash}`,
    chainName: BASE_SEPOLIA_CHAIN.name,
    chainId: BASE_SEPOLIA_CHAIN.id,
    tokenAddress: BASE_SEPOLIA_USDC_ADDRESS,
    tokenDecimals: 6,
    tokenLabel: "USDC (Circle official)",
    agentAddress: connector.agentAddress,
  };
}

// ----------------------------------------------------------------------------
//  Context builder
// ----------------------------------------------------------------------------
async function _buildContext(): Promise<AppContext> {
  loadDotenvLocal(findRepoRoot());

  // Layer 2: SessionManager — DynamoDB in production (multi-Lambda safe), InMemory locally
  let sessionManager: SessionManager;
  const sessionsTableName = process.env["SESSIONS_TABLE_NAME"];
  if (sessionsTableName) {
    try {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      sessionManager = new DynamoDBSessionManager({
        tableName: sessionsTableName,
        client: docClient,
      });
      console.log(
        `[session] DynamoDB persistence enabled (table=${sessionsTableName})`
      );
    } catch (err) {
      console.warn(
        "[session] DynamoDB SessionManager init failed, falling back to in-memory:",
        err
      );
      sessionManager = new InMemorySessionManager();
    }
  } else {
    sessionManager = new InMemorySessionManager();
  }
  const connectors = new Map<WalletProviderId, ConnectorBundle>();

  // Build HashKey first (the default — preserves old behavior)
  const hashKey = await buildHashKeyBundle();
  if (hashKey) {
    connectors.set(hashKey.walletProvider, hashKey);
  }

  // Build Coinbase CDP (path D other half)
  const cdp = await buildCoinbaseCdpBundle();
  if (cdp) {
    connectors.set(cdp.walletProvider, cdp);
  }

  // Build the 11 self-contained v0.11 connectors (no creds needed — each
  // generates a real testnet keypair in-process). These make the demo-web
  // capability bar show the full multi-chain matrix out of the box.
  const { buildSelfContainedBundles } = await import(
    "./self-contained-wallets.js"
  );
  for (const bundle of buildSelfContainedBundles()) {
    if (!connectors.has(bundle.walletProvider)) {
      connectors.set(bundle.walletProvider, bundle);
    }
  }

  if (connectors.size === 0) {
    throw new Error(
      "No wallet connectors configured — set HASHKEY_* or COINBASE_CDP_* env vars"
    );
  }

  // Build manager and register all connectors with a unified resolveInstrument
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => {
      // Try each connector's store
      for (const bundle of connectors.values()) {
        const c = bundle.connector as any;
        if (c.config?.instrumentStore?.getById) {
          const inst = await c.config.instrumentStore.getById(id);
          if (inst) return inst;
        }
        // HashKey uses a private `store` field via constructor — fallback via type assertion
        if (c.store?.getById) {
          const inst = await c.store.getById(id);
          if (inst) return inst;
        }
      }
      return undefined;
    },
  });
  for (const bundle of connectors.values()) {
    manager.registerConnector(bundle.connector);
  }

  // Default provider: HashKey if available (backward compat), else first
  const defaultProvider = (hashKey?.walletProvider ??
    [...connectors.keys()][0]) as WalletProviderId;

  // -------------------------------------------------------------------------
  //  Governance — Policy + Compliance + Audit (Guardrail Layer 3, 5, 7)
  // -------------------------------------------------------------------------
  const policyEngine = new InMemoryPolicyEngine();

  // Demo policies (sensible defaults — production would tune these per agent)
  policyEngine.use(
    amountThreshold({
      maxAtomic: BigInt(50 * 1e6).toString(), // $50 hard cap per single tx
      currency: "USDC",
    })
  );
  policyEngine.use(
    velocityLimit({
      windowMs: 60 * 1000, // 1 minute
      maxCount: 20, // max 20 payments per minute
    })
  );
  policyEngine.use(
    velocityLimit({
      windowMs: 60 * 60 * 1000, // 1 hour
      maxAmountAtomic: BigInt(100 * 1e6).toString(), // $100 cap per hour
      currency: "USDC",
    })
  );

  const complianceChecker = new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]);

  // -------------------------------------------------------------------------
  //  Layer 7 audit sink — DynamoDB in production, InMemory locally.
  //  We keep an InMemoryAuditSink reference too, so /api/governance can show
  //  recent events from a fast in-process buffer without DynamoDB read costs.
  // -------------------------------------------------------------------------
  const auditTableName = process.env["AUDIT_TABLE_NAME"];
  const inMemoryAuditSink = new InMemoryAuditSink(500);
  let auditSink: AuditSink = inMemoryAuditSink;
  let dynamoSink: DynamoDBAuditSink | undefined;
  if (auditTableName) {
    try {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      dynamoSink = new DynamoDBAuditSink({
        tableName: auditTableName,
        client: docClient,
      });
      // Composite sink: write to BOTH (DynamoDB durable + in-memory hot path).
      auditSink = {
        async emit(event: AuditEvent) {
          inMemoryAuditSink.emit(event);
          try {
            await dynamoSink!.emit(event);
          } catch (err) {
            // Audit failure shouldn't kill the request — log and continue
            console.error("[audit] DynamoDB emit failed:", err);
          }
        },
      };
      console.log(
        `[audit] DynamoDB persistence enabled (table=${auditTableName})`
      );
    } catch (err) {
      console.warn("[audit] DynamoDB sink disabled:", err);
    }
  }

  const governance = new GovernanceManager({
    policyEngine,
    complianceChecker,
    auditSink,
  });

  const policyDescriptions = policyEngine.list();

  return {
    manager,
    sessionManager,
    demoUserId: "demo-user" as UserId,
    connectors,
    defaultProvider,
    governance,
    auditSink: inMemoryAuditSink,
    ...(dynamoSink ? { dynamoSink } : {}),
    policyDescriptions,
    recentPayments: [],
  };
}

/** Synchronous accessor (works after first async warmup). */
export function context(): AppContext {
  if (_ctx) return _ctx;
  throw new Error(
    "Context not initialized — call ensureContext() first (Lambda) or wait for boot (Express)"
  );
}

/** Async warmup — call once at boot or first request. */
export async function ensureContext(): Promise<AppContext> {
  if (_ctx) return _ctx;
  if (_ctxPromise) return _ctxPromise;
  _ctxPromise = (async () => {
    _ctx = await _buildContext();
    return _ctx;
  })();
  return _ctxPromise;
}

/** Get bundle by walletProvider, falling back to default if not found. */
export function getBundle(
  ctx: AppContext,
  walletProvider?: string
): ConnectorBundle {
  if (walletProvider) {
    const b = ctx.connectors.get(walletProvider as WalletProviderId);
    if (b) return b;
    // unknown — fall back to default
  }
  const def = ctx.connectors.get(ctx.defaultProvider);
  if (!def) throw new Error("No connector available");
  return def;
}

/** Reset for tests. */
export function _resetContext(): void {
  _ctx = null;
  _ctxPromise = null;
}

/** Inject a pre-built context — for tests only. */
export function __setContextForTest(ctx: AppContext): void {
  _ctx = ctx;
  _ctxPromise = Promise.resolve(ctx);
}

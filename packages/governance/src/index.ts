/**
 * @openagentpay/governance — Spending Controls, Compliance, Audit
 *
 * Inspired by AWS Bedrock AgentCore Payments' 7-layer Guardrail design:
 *
 *   Layer 1: Authorization      (out of scope — handled by upstream auth)
 *   Layer 2: Session            (already in @openagentpay/core SessionManager)
 *   Layer 3: Policy             ← THIS PACKAGE — velocity/merchant/amount rules
 *   Layer 4: On-chain           (already in wallet connectors via EIP-3009)
 *   Layer 5: Compliance         ← THIS PACKAGE — sanctions/OFAC checks
 *   Layer 6: Identity           (already via AWS Secrets Manager + KMS)
 *   Layer 7: Audit              ← THIS PACKAGE — append-only audit log
 *
 * @license Apache-2.0
 */

// Policy engine
export { InMemoryPolicyEngine } from "./policy.js";
export type {
  Policy,
  PolicyDecision,
  PolicyEngine,
  PolicyEvaluationContext,
  RecentPaymentRecord,
} from "./policy.js";

// Built-in policies (functions, not types)
export {
  velocityLimit,
  amountThreshold,
  merchantWhitelist,
  merchantBlacklist,
  walletProviderWhitelist,
  timeOfDay,
} from "./policy.js";

// Compliance
export {
  StaticSanctionsChecker,
  CompositeComplianceChecker,
  DEMO_SANCTIONS_LIST,
} from "./compliance.js";
export type {
  ComplianceChecker,
  ComplianceCheckResult,
  SanctionsList,
} from "./compliance.js";

// Audit
export {
  AuditLogger,
  InMemoryAuditSink,
  ConsoleAuditSink,
} from "./audit.js";
export type { AuditEvent, AuditEventKind, AuditSink } from "./audit.js";

// DynamoDB sink (Layer 7 production persistence — peer dep on @aws-sdk)
export { DynamoDBAuditSink } from "./dynamodb-sink.js";
export type {
  DynamoDBAuditSinkConfig,
  DynamoDBDocClientLike,
  CommandFactories,
  AuditQueryResult,
} from "./dynamodb-sink.js";

// S3 WORM sink (Layer 7 immutable persistence — Object Lock COMPLIANCE mode)
export { S3WormAuditSink, DEFAULT_WORM_RETENTION_DAYS } from "./s3-worm-sink.js";
export type {
  S3WormAuditSinkConfig,
  S3ClientLike,
  S3CommandFactories,
} from "./s3-worm-sink.js";

// Top-level facade
export { GovernanceManager } from "./manager.js";
export type {
  GovernanceConfig,
  PreCheckInput,
  PreCheckResult,
} from "./manager.js";

// ----------------------------------------------------------------------------
//  v0.10 production extensions — checkers, approval, per-agent, jurisdiction
// ----------------------------------------------------------------------------

// Production compliance checkers
export { ChainalysisKYTChecker } from "./checkers/chainalysis.js";
export type { ChainalysisKYTConfig } from "./checkers/chainalysis.js";
export { TRMLabsChecker } from "./checkers/trm-labs.js";
export type { TRMLabsConfig } from "./checkers/trm-labs.js";
export { OFACSdnAutoSyncChecker } from "./checkers/ofac-sdn.js";
export type { OFACSdnAutoSyncConfig } from "./checkers/ofac-sdn.js";

// Approval workflow (Cobo PACT-inspired)
export {
  ApprovalManager,
  InMemoryApprovalStore,
} from "./approval/manager.js";
export type {
  ApprovalRequest,
  ApprovalEvent,
  ApprovalStatus,
  ApprovalStore,
  ApprovalManagerConfig,
} from "./approval/manager.js";

// Per-agent policy bundles
export { PerAgentPolicyEngine } from "./policy/per-agent.js";
export type {
  PerAgentPolicyBundle,
  PerAgentPolicyEngineConfig,
} from "./policy/per-agent.js";

// Jurisdiction restriction policy
export { jurisdictionRestriction } from "./policy/jurisdiction.js";
export type { JurisdictionRestrictionOptions } from "./policy/jurisdiction.js";

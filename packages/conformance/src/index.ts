/**
 * @openagentpay/conformance
 * =========================
 *
 * Conformance test suite for OpenAgentPay WalletConnector + ProtocolAdapter
 * implementations. Third parties writing new connectors / adapters import
 * these utilities into their test files and call:
 *
 *     import { describe, it, expect, beforeAll } from "vitest";
 *     import {
 *       runWalletConformance,
 *       type TestRunner,
 *     } from "@openagentpay/conformance/wallet";
 *
 *     const runner: TestRunner = { describe, it, expect: expect as never, beforeAll };
 *     runWalletConformance(runner, fixture, options);
 *
 * Design philosophy: the suite is **framework-agnostic** — your test runner
 * is injected as the first arg, so vitest / jest / mocha+chai all work.
 *
 * @license Apache-2.0
 */

export {
  runWalletConformance,
  WALLET_CONFORMANCE_GROUPS,
  type WalletConformanceFixture,
  type WalletConformanceOptions,
  type ConformanceReport,
  type TestRunner,
  type TestExpectation,
} from "./wallet.js";

export {
  runProtocolConformance,
  type ProtocolConformanceFixture,
  type ProtocolConformanceOptions,
} from "./protocol.js";

export {
  runCompositionConformance,
  type CompositionAdapter,
  type CompositionConformanceFixture,
  type CompositionConformanceOptions,
} from "./compose.js";

export { CONFORMANCE_VERSION } from "./version.js";

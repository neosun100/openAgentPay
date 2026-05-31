/**
 * Unit tests for the Certify tab's pure formatting helpers.
 *
 * demo-web has no vitest/jsdom setup, so per project convention these cover the
 * dependency-free helpers via Node's built-in test runner (`node --test`),
 * adding real coverage without pulling in a browser test stack.
 *
 * @license Apache-2.0
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
// NOTE: .ts specifier (not .js) — this file runs under `node --test` with
// native type stripping and is excluded from the tsc build (see tsconfig).
import { formatCertResult, truncateProof } from "./certFormat.ts";

test("formatCertResult — all passed, no skips", () => {
  assert.equal(
    formatCertResult({ passed: 25, skipped: 0, total: 25, allPassed: true }),
    "25/25 passed"
  );
});

test("formatCertResult — appends skipped count when > 0", () => {
  assert.equal(
    formatCertResult({ passed: 23, skipped: 2, total: 25, allPassed: true }),
    "23/25 passed · 2 skipped"
  );
});

test("formatCertResult — protocol suite shape", () => {
  assert.equal(
    formatCertResult({ passed: 13, skipped: 0, total: 13, allPassed: true }),
    "13/13 passed"
  );
});

test("truncateProof — truncates long hex with ellipsis", () => {
  const proof =
    "9a3f7c2e1b8d04f6a5c9e2017d4b8e3f6a1c0d9b7e4f2a8c3d6b1e0f9a4c7d2e";
  const out = truncateProof(proof);
  assert.equal(out, "9a3f7c2e1b…9a4c7d2e");
  assert.ok(out.includes("…"));
});

test("truncateProof — leaves short strings untouched", () => {
  assert.equal(truncateProof("abc"), "abc");
});

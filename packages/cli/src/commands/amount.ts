/**
 * `parseAmount` — parse a human amount string like "1.5USDC" into atomic Money.
 *
 * Shared by `oap pay`. Kept in its own module so it has a focused unit test.
 *
 * @license Apache-2.0
 */

import type { Money } from "@openagentpay/core";

/** Known decimals per currency symbol. Default fallback is 6 (USDC-like). */
const DECIMALS: Readonly<Record<string, number>> = {
  USD: 2,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  ETH: 18,
  WETH: 18,
  BTC: 8,
  SOL: 9,
};

/** Default decimals when the currency is unknown (USDC convention). */
export const DEFAULT_DECIMALS = 6;

/**
 * Parse an amount string into a {@link Money}.
 *
 * Accepts:
 *   "1.5USDC"   → { amountAtomic: "1500000", decimals: 6, currency: "USDC" }
 *   "10 USDC"   → whitespace between number and currency allowed
 *   "0.000001USDC" → exact atomic precision (1)
 *
 * Rejects: empty input, missing currency, missing number, negative,
 * non-numeric, or more decimal places than the currency supports.
 */
export function parseAmount(input: string): Money {
  if (typeof input !== "string") {
    throw new AmountParseError("amount must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new AmountParseError("amount is empty");
  }

  // <number><optional ws><currency letters>
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{2,10})$/.exec(trimmed);
  if (!match) {
    throw new AmountParseError(
      `malformed amount "${input}" — expected e.g. "1.5USDC"`
    );
  }
  const numberPart = match[1]!;
  const currency = match[2]!.toUpperCase();

  const decimals = DECIMALS[currency] ?? DEFAULT_DECIMALS;

  const [intPart, fracPartRaw = ""] = numberPart.split(".");
  const fracPart = fracPartRaw;
  if (fracPart.length > decimals) {
    throw new AmountParseError(
      `amount "${input}" has ${fracPart.length} decimal places but ${currency} supports only ${decimals}`
    );
  }

  // Combine integer + zero-padded fractional into a single atomic bigint.
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const atomicStr = `${intPart}${paddedFrac}`;
  // Strip leading zeros but keep at least one digit.
  const amountAtomic = BigInt(atomicStr).toString();

  if (amountAtomic === "0") {
    throw new AmountParseError(`amount "${input}" resolves to zero`);
  }

  return { amountAtomic, decimals, currency };
}

export class AmountParseError extends Error {
  override readonly name = "AmountParseError";
}

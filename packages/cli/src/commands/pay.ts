/**
 * `oap pay` — execute a single payment via the in-process PaymentManager.
 *
 *   oap pay --to <recipient> --amount <1.5USDC> --wallet <provider>
 *           [--session <id>] [--config PATH]
 *
 * Flow:
 *   1. parse --amount into atomic Money
 *   2. ensure a session (use --session if given, else mint an ephemeral one)
 *   3. ensure an instrument bound to --wallet (requires the connector to be
 *      registered; absent connectors → clean non-zero exit)
 *   4. processPayment → print tx hash / settlement result
 *
 * Exit codes:
 *   0  settlement succeeded
 *   2  bad argv
 *   3  config load failure
 *   6  payment failed (no connector / settlement error / session rejected)
 *
 * @license Apache-2.0
 */

import {
  PaymentManagerError,
  type Instrument,
  type InstrumentId,
  type PaymentManager,
  type PaymentRequest,
  type Session,
  type SessionId,
  type UserId,
  type WalletProviderId,
} from "@openagentpay/core";

import { flag, type CommandContext } from "../io.js";
import { AmountParseError, parseAmount } from "./amount.js";
import { buildRuntime, type RuntimeManager } from "./session.js";

const EXIT_PAYMENT_FAILED = 6;

export async function cmdPay(
  argv: ReadonlyArray<string>,
  ctx: CommandContext,
  injected?: PaymentManager
): Promise<number> {
  const to = flag(argv, "--to", "-t");
  const amountStr = flag(argv, "--amount", "-a");
  const wallet = flag(argv, "--wallet", "-w");
  const sessionId = flag(argv, "--session", "-s");
  const configPath = flag(argv, "--config", "-c");

  if (!to) {
    ctx.err("oap pay: missing --to <recipient>");
    return 2;
  }
  if (!amountStr) {
    ctx.err("oap pay: missing --amount <e.g. 1.5USDC>");
    return 2;
  }
  if (!wallet) {
    ctx.err("oap pay: missing --wallet <provider>");
    return 2;
  }

  let amount;
  try {
    amount = parseAmount(amountStr);
  } catch (err) {
    if (err instanceof AmountParseError) {
      ctx.err(`✘ ${err.message}`);
      return 2;
    }
    throw err;
  }

  // Build / reuse the runtime manager.
  let manager = injected;
  let store: Map<string, Instrument> | undefined;
  if (!manager) {
    try {
      const rt = buildRuntime(ctx, configPath ?? undefined);
      manager = rt.manager;
      store = (rt.manager as RuntimeManager).__instruments;
    } catch (err) {
      ctx.err(`✘ ${err instanceof Error ? err.message : String(err)}`);
      return 3;
    }
  } else {
    store = (manager as RuntimeManager).__instruments;
  }

  const provider = wallet as WalletProviderId;

  // 1. Ensure a session.
  let session: Session | undefined;
  if (sessionId !== undefined) {
    session = await manager.getPaymentSession(sessionId as SessionId);
    if (!session) {
      ctx.err(`✘ session not found: ${sessionId}`);
      return EXIT_PAYMENT_FAILED;
    }
  } else {
    session = await manager.createPaymentSession({
      userId: "oap-cli" as UserId,
      budgetUsd: 1_000_000, // ephemeral: do not block the explicit pay
      expiresMinutes: 5,
    });
  }

  // 2. Ensure an instrument bound to the requested wallet provider.
  //    Prefer the connector's own createInstrument; if no connector is
  //    registered this throws connector_not_registered → clean failure.
  let instrument: Instrument;
  try {
    instrument = await manager.createPaymentInstrument(provider, {
      userId: session.userId,
    });
  } catch (err) {
    return reportPaymentError(err, ctx, provider);
  }
  // Make the instrument resolvable by processPayment's resolver.
  if (store) store.set(instrument.id, instrument);

  // 3. Build the PaymentRequest. CLI pay defaults to the x402-v1 protocol
  //    envelope with a wide validity window; settlement specifics belong to
  //    the connector.
  const nowSec = Math.floor(Date.now() / 1000);
  const request: PaymentRequest = {
    protocol: "x402-v1" as PaymentRequest["protocol"],
    amount,
    recipient: to,
    asset: { symbol: amount.currency, decimals: amount.decimals },
    validAfter: nowSec - 60,
    validBefore: nowSec + 3600,
    nonce: `0x${nowSec.toString(16)}`,
    rawPayload: { source: "oap-cli" },
    description: `oap pay ${amountStr} → ${to}`,
  };

  // 4. Process.
  let result;
  try {
    result = await manager.processPayment({
      sessionId: session.id,
      instrumentId: instrument.id as InstrumentId,
      request,
    });
  } catch (err) {
    return reportPaymentError(err, ctx, provider);
  }

  if (!result.success) {
    ctx.err(
      `✘ payment failed: ${result.settlement.errorCode ?? "unknown"}` +
        (result.settlement.errorMessage
          ? ` — ${result.settlement.errorMessage}`
          : "")
    );
    return EXIT_PAYMENT_FAILED;
  }

  ctx.log(`✔ payment settled`);
  ctx.log(`  wallet    ${provider}`);
  ctx.log(`  to        ${to}`);
  ctx.log(
    `  amount    ${amount.amountAtomic} (${amount.currency}, ${amount.decimals} decimals)`
  );
  ctx.log(`  network   ${result.settlement.network}`);
  if (result.settlement.transactionRef !== undefined) {
    ctx.log(`  tx        ${result.settlement.transactionRef}`);
  }
  ctx.log(`  session   ${session.id}`);
  return 0;
}

// ---------------------------------------------------------------------------

function reportPaymentError(
  err: unknown,
  ctx: CommandContext,
  provider: WalletProviderId
): number {
  if (err instanceof PaymentManagerError) {
    if (err.code === "connector_not_registered") {
      ctx.err(
        `✘ no wallet connector registered for "${provider}". ` +
          `Declare it in openagentpay.yaml and ensure its module is installed.`
      );
    } else {
      ctx.err(`✘ payment failed (${err.code}): ${err.message}`);
    }
    return EXIT_PAYMENT_FAILED;
  }
  ctx.err(`✘ payment failed: ${err instanceof Error ? err.message : String(err)}`);
  return EXIT_PAYMENT_FAILED;
}

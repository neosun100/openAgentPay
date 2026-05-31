/**
 * @openagentpay/protocol-ap2 — AP2 v0.2 A2A negotiation skeleton
 * ==============================================================
 *
 * AP2 v0.2 layers *agent-to-agent mandate negotiation* on top of the existing
 * AP2 mandate flow (see `adapter.ts`). Two agents exchange `AgentPaymentCard`s
 * (the A2A-discovery business-card shape), intersect the protocols/assets each
 * side accepts, deterministically pick a winner by the *local* card's priority
 * order, and — on agreement — emit an AP2 Mandate stub through the existing
 * `Ap2ProtocolAdapter` helpers.
 *
 * This is pure & offline:
 *   - no network, no clock dependence (a deterministic clock can be injected),
 *   - the signature step is a pluggable hook (default: no-op), mirroring the
 *     `CardSignatureHook` pattern in `protocol-a2a-discovery`.
 *
 * It deliberately does NOT re-implement the AgentPaymentCard / negotiate()
 * logic — it reuses the `AgentPaymentCard` type from
 * `@openagentpay/protocol-a2a-discovery` and the `Mandate` builders from this
 * package's `adapter.ts`.
 *
 * @license Apache-2.0
 */

import type {
  Asset,
  Mandate,
  ProtocolId,
} from "@openagentpay/core";
import type { AgentPaymentCard } from "@openagentpay/protocol-a2a-discovery";
import { buildCartMandate, buildPaymentMandate } from "./adapter.js";

// ============================================================================
//  Constants
// ============================================================================

export const AP2_V2_VERSION = "0.2" as const;

// ============================================================================
//  Pluggable signature hook (injected function, default no-op)
// ============================================================================

/**
 * Signs (or otherwise endorses) the negotiated mandate stub. Injected as a
 * plain function so callers can plug in a DID/JWS signer; the default is a
 * structural no-op that returns the supplied proof value unchanged.
 *
 * Receives the deterministic "what was agreed" tuple so a real implementation
 * can bind its signature to the negotiation outcome.
 */
export type Ap2V2SignatureHook = (input: {
  readonly localCard: AgentPaymentCard;
  readonly remoteCard: AgentPaymentCard;
  readonly chosenProtocol: ProtocolId;
  readonly chosenAsset: Asset;
}) => Mandate["proof"];

/** Default no-op proof — accepts/produces a placeholder, never throws. */
export const NULL_AP2_V2_PROOF: Mandate["proof"] = {
  type: "NullSignature",
  created: "1970-01-01T00:00:00Z",
  verificationMethod: "did:openagent:null#noop",
  proofPurpose: "assertionMethod",
  proofValue: "ap2-v0.2-null-proof",
};

const nullSignatureHook: Ap2V2SignatureHook = () => NULL_AP2_V2_PROOF;

// ============================================================================
//  Negotiation result
// ============================================================================

/**
 * Outcome of an AP2 v0.2 negotiation. Exactly one of (`mandate` + the chosen
 * fields) OR (`rejected`) is meaningful:
 *   - success → `chosenProtocol`/`chosenAsset` set, `mandate` is the stub,
 *     `rejected` absent.
 *   - failure → `rejected` is the human-readable reason; `chosenProtocol`
 *     /`chosenAsset` are `undefined` and `mandate` absent.
 */
export interface Ap2NegotiationResult {
  /** Whether the two cards reached agreement. */
  readonly agreed: boolean;
  /** AP2 protocol version used for the negotiation. */
  readonly version: typeof AP2_V2_VERSION;
  /** Settlement protocol both sides accepted (local-priority winner). */
  readonly chosenProtocol?: ProtocolId;
  /** Asset both sides accepted (local-priority winner). */
  readonly chosenAsset?: Asset;
  /** AP2 Mandate stub emitted on success (Cart + Payment chain). */
  readonly mandate?: readonly Mandate[];
  /** Reason the negotiation failed (no protocol/asset overlap). */
  readonly rejected?: string;
}

// ============================================================================
//  Negotiator config
// ============================================================================

export interface Ap2V2NegotiatorConfig {
  /** Pluggable signature hook — default: structural no-op. */
  readonly signatureHook?: Ap2V2SignatureHook;
  /**
   * Issuer DID/URI stamped onto the emitted mandate stub. Defaults to the
   * local card's `agentId` so the stub is self-describing.
   */
  readonly issuer?: string;
  /** Override clock for deterministic tests (ms epoch). Default: fixed 0. */
  readonly now?: () => number;
}

// ============================================================================
//  Ap2V2Negotiator
// ============================================================================

/**
 * Drives AP2 v0.2 agent-to-agent negotiation between a *local* card (the payer)
 * and a *remote* card (the counterparty). Pure & offline.
 */
export class Ap2V2Negotiator {
  private readonly signatureHook: Ap2V2SignatureHook;
  private readonly issuerOverride: string | undefined;
  private readonly now: () => number;

  constructor(config: Ap2V2NegotiatorConfig = {}) {
    this.signatureHook = config.signatureHook ?? nullSignatureHook;
    this.issuerOverride = config.issuer;
    this.now = config.now ?? (() => 0);
  }

  /**
   * Negotiate a (protocol, asset) agreement between `localCard` and
   * `remoteCard`, then emit an AP2 Mandate stub on success.
   *
   * Determinism: the winner is the FIRST entry in the *local* card's
   * preference order that the remote card also accepts. Assets are matched by
   * `symbol`. No overlap → `{ agreed: false, rejected }`.
   */
  negotiate(
    localCard: AgentPaymentCard,
    remoteCard: AgentPaymentCard
  ): Ap2NegotiationResult {
    const chosenProtocol = firstOverlap(
      localCard.acceptedProtocols,
      remoteCard.acceptedProtocols
    );
    if (chosenProtocol === undefined) {
      return {
        agreed: false,
        version: AP2_V2_VERSION,
        rejected: `No overlapping protocol between ${localCard.agentId} and ${remoteCard.agentId}`,
      };
    }

    const chosenAsset = firstOverlapAsset(
      localCard.acceptedAssets,
      remoteCard.acceptedAssets
    );
    if (chosenAsset === undefined) {
      return {
        agreed: false,
        version: AP2_V2_VERSION,
        rejected: `No overlapping asset between ${localCard.agentId} and ${remoteCard.agentId}`,
      };
    }

    const mandate = this.buildMandateStub(
      localCard,
      remoteCard,
      chosenProtocol,
      chosenAsset
    );

    return {
      agreed: true,
      version: AP2_V2_VERSION,
      chosenProtocol,
      chosenAsset,
      mandate,
    };
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  /**
   * Build a minimal Cart→Payment AP2 Mandate stub via the existing adapter
   * factories. The signature hook supplies the proof (default no-op).
   */
  private buildMandateStub(
    localCard: AgentPaymentCard,
    remoteCard: AgentPaymentCard,
    chosenProtocol: ProtocolId,
    chosenAsset: Asset
  ): readonly Mandate[] {
    const issuer = this.issuerOverride ?? localCard.agentId;
    const proof = this.signatureHook({
      localCard,
      remoteCard,
      chosenProtocol,
      chosenAsset,
    });
    const issuanceDate = new Date(this.now()).toISOString();
    const cartId = `urn:ap2-v0.2:cart:${localCard.agentId}:${remoteCard.agentId}`;
    const paymentId = `urn:ap2-v0.2:payment:${localCard.agentId}:${remoteCard.agentId}`;

    // Stub amount: zero — v0.2 negotiation establishes the (protocol, asset)
    // handshake; the concrete cart total is filled in by the downstream
    // AP2 mandate flow once the order is known.
    const cart = buildCartMandate({
      id: cartId,
      issuer,
      subjectId: remoteCard.agentId,
      intentMandateId: `urn:ap2-v0.2:intent:${localCard.agentId}`,
      totalAtomic: "0",
      currency: chosenAsset.symbol,
      decimals: chosenAsset.decimals,
      merchant: remoteCard.agentId,
      lineItems: [
        {
          sku: "ap2-v0.2-negotiation",
          description: `Negotiated handshake ${localCard.agentId}→${remoteCard.agentId}`,
          quantity: 1,
          unitPriceAtomic: "0",
        },
      ],
      issuanceDate,
      proof,
    });

    const payment = buildPaymentMandate({
      id: paymentId,
      issuer,
      subjectId: remoteCard.agentId,
      cartMandateId: cartId,
      settlementProtocol: chosenProtocol,
      settlementPayload: {
        negotiation: {
          version: AP2_V2_VERSION,
          local: localCard.agentId,
          remote: remoteCard.agentId,
          asset: chosenAsset.symbol,
        },
      },
      presence: "agent_present",
      issuanceDate,
      proof,
    });

    return [cart, payment];
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/**
 * First entry of `mine` (the local priority order) that also appears in
 * `theirs`. Returns `undefined` when there is no overlap.
 */
function firstOverlap<T>(mine: readonly T[], theirs: readonly T[]): T | undefined {
  const set = new Set<T>(theirs);
  for (const x of mine) {
    if (set.has(x)) return x;
  }
  return undefined;
}

/**
 * Asset intersection by `symbol`, preserving local priority order. The local
 * card's asset object (decimals etc.) is the one returned, so the payer's view
 * of the asset wins.
 */
function firstOverlapAsset(
  mine: readonly Asset[],
  theirs: readonly Asset[]
): Asset | undefined {
  const theirSymbols = new Set(theirs.map((a) => a.symbol));
  for (const a of mine) {
    if (theirSymbols.has(a.symbol)) return a;
  }
  return undefined;
}

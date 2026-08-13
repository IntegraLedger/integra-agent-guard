import {
  type CarrierClass,
  decodeDeclaredRead,
  type LegalContextRef,
  type PlacementContainer,
  type PlacementEncoding,
  type PlacementManifest,
  type ProtocolId,
  readAtPath,
  readDeclaredPaths,
  readFromContainer,
} from "@integraledger/lcp-binding-core";
import {
  type PlacementDeployment,
  placementFor,
} from "@integraledger/lcp-placements";
import {
  type GateProposal,
  type ProposalContext,
  parseProposalFromChallenge,
} from "./proposal.js";
import { parseProposalFromAcpCheckout } from "./proposal-acp.js";

// ---------------------------------------------------------------------------------------------------------
// Structural predicates. Every read goes through `readAtPath`, never through `doc.x` or `doc["x"]`, so the
// own-property and array-traversal rules a hostile wire is read under are binding-core's audited ones rather
// than a second set invented here. A prototype key answering as though it were a declared field is exactly
// how a detector gets talked into naming the wrong protocol.
// ---------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringAt(doc: unknown, path: string): boolean {
  return typeof readAtPath(doc, path) === "string";
}

function isArrayAt(doc: unknown, path: string): boolean {
  return Array.isArray(readAtPath(doc, path));
}

function stringAtIsOneOf(
  doc: unknown,
  path: string,
  permitted: readonly string[],
): boolean {
  const value = readAtPath(doc, path);
  // `some` rather than a `typeof` guard plus `includes`: the guard would be a branch no input can take, since
  // a list of strings never contains a non-string, and a branch nothing reaches is one no test can constrain.
  return permitted.some((token) => token === value);
}

/**
 * ACP's `CheckoutSession.status` — the closed eleven-value enum, and the discriminant that separates an ACP
 * session from every other checkout-shaped document in the set.
 *
 * DERIVED, NOT AUTHORED — from the live ACP schema, which `placement-acp` enumerated protocol-side in a
 * write condition it no longer declares (checked 2026-07-30).
 *
 * ⚠️ THIS COPY NO LONGER HAS A DRIFT GUARD. It was pinned equal to the manifest's write condition through
 * the registry, but the protocol line declares no `writeCondition` on any ACP manifest — its `readAlso` aliases
 * carry `{path, encoding}` only — so the enum is not published anywhere to pin against. The pin test was
 * deleted rather than loosened (an assertion over an absent field guards nothing). Re-derive this list
 * against the live ACP schema when touching it; the discriminant tests only prove it matches our fixtures.
 */
export const ACP_SESSION_STATUS: readonly string[] = [
  "incomplete",
  "not_ready_for_payment",
  "requires_escalation",
  "authentication_required",
  "ready_for_payment",
  "pending_approval",
  "complete_in_progress",
  "completed",
  "canceled",
  "in_progress",
  "expired",
];

/**
 * The two Verifiable Intent Autonomous-mode credential types, derived from Mastercard's own open-mandate
 * definitions. Formerly pinned against `placement-mastercard-vi`'s write condition; that placement is now
 * declaration-only (LCP v1.38 §C.7 — an unregistered constraint type gets the WHOLE mandate rejected by a
 * stock verifier), so it declares no write condition and there is nothing to pin against. Same standing as
 * {@link ACP_SESSION_STATUS}: hand-kept, re-derive against the host when touching it.
 */
export const VI_OPEN_MANDATE_VCT: readonly string[] = [
  "mandate.checkout.open.1",
  "mandate.payment.open.1",
];

/** The two AP2 v0.2 mandate DataPart keys. An envelope carrying either is carrying an AP2 mandate. */
const AP2_MANDATE_DATA_KEYS: readonly string[] = [
  "ap2.mandates.CheckoutMandateSdJwt",
  "ap2.mandates.PaymentMandateSdJwt",
];

/** Visa TAP's two agent-recognition signature tags, as they appear quoted in an RFC 9421 `Signature-Input`. */
const TAP_SIGNATURE_TAGS: readonly string[] = [
  "agent-browser-auth",
  "agent-payer-auth",
];

/** An A2A `Task`: `id` and `status` are the two REQUIRED members (a2a.proto lines 178-190). */
function isA2aTask(doc: unknown): boolean {
  return isStringAt(doc, "id") && isStringAt(doc, "status.state");
}

/** An A2A `Message`: `messageId`, `role` and `parts` are its three REQUIRED members (a2a.proto 267-280). */
function isA2aMessage(doc: unknown): boolean {
  return (
    isStringAt(doc, "messageId") &&
    isStringAt(doc, "role") &&
    isArrayAt(doc, "parts")
  );
}

/**
 * Does this document carry an AP2 mandate DataPart?
 *
 * Reads `parts` itself rather than trusting a caller to have checked it, because the AP2 rule asks this
 * question FIRST — the mandate part is AP2's own half of the discriminant, and the A2A envelope check is a
 * second, weaker fact about it.
 */
function carriesAp2Mandate(doc: unknown): boolean {
  const parts = readAtPath(doc, "parts");
  if (!Array.isArray(parts)) return false;
  return parts.some((_, index) => {
    const data = readAtPath(doc, `parts.${index}.data`);
    return (
      isRecord(data) &&
      AP2_MANDATE_DATA_KEYS.some((key) => Object.hasOwn(data, key))
    );
  });
}

// ---------------------------------------------------------------------------------------------------------
// The discriminant table
// ---------------------------------------------------------------------------------------------------------

/**
 * How ONE protocol's document is recognized — or the recorded fact that it cannot be.
 *
 * A keyed union rather than an optional `matches`, because "no rule" and "a rule that never fires" are
 * different claims and only one of them is honest about a protocol whose document carries nothing to
 * recognize. An `undiscriminable` row is a finding with a citation, not a hole: it says the live specification
 * was read and no identifying member exists, which is the answer a future unit needs in order not to redo the
 * reading, and it keeps the table TOTAL over the placement registry so a newly registered protocol cannot slip
 * in unnoticed.
 *
 * `cite` is data rather than a comment because a claim about somebody else's protocol is exactly the kind that
 * gets stale, and an audit trail that only a reader of the source can see is not one a deployment can act on.
 */
export type ProtocolDiscriminant =
  | {
      readonly protocol: ProtocolId;
      readonly kind: "structural";
      /** Does this document belong to `protocol`? TOTAL — never throws, on any shape a wire can present. */
      readonly matches: (doc: unknown) => boolean;
      /** The host protocol's own source the rule was read from, and when. */
      readonly cite: string;
    }
  | {
      readonly protocol: ProtocolId;
      readonly kind: "undiscriminable";
      /** Why no rule exists, and where the protocol's identity actually lives instead. */
      readonly reason: string;
      readonly cite: string;
    };

/**
 * Every supported protocol's document discriminant, one row each.
 *
 * DETECTION IS BY DISCRIMINANT, NEVER BY "does the field I want happen to be present": a document is x402
 * because it carries `x402Version`, not because it has an atrHash somewhere. Detecting on the LCP field would
 * make every protocol look alike the moment it carried a reference — which is exactly the situation this table
 * exists to disambiguate.
 *
 * EVERY RULE IS POSITIVE. No row says "and not the other protocol's marker". Documents CAN satisfy two rows,
 * and where they do the answer is AMBIGUITY, which {@link parseProposalUniversal} refuses. A negative term
 * would convert that refusal into a silent choice, and a wrong negative term (one protocol adding a field
 * another already had) converts it into a silent WRONG choice. Refusing is never the wrong answer; guessing
 * sometimes is.
 *
 * THE TWO OVERLAPS ARE NOT THE SAME STRENGTH, and the difference is load-bearing:
 *
 *  - ACP/UCP is CONTINGENT. A UCP checkout response that also carries `currency`, `totals` and `line_items`
 *    satisfies both rows; one that does not carries only `ucp`, `id`, `status` and `links` and is
 *    unambiguously UCP. Either protocol's documents remain individually reachable.
 *  - AP2/A2A is TOTAL. `ap2` matches `carriesAp2Mandate(doc) && isA2aMessage(doc)`, and `a2a` matches
 *    `isA2aTask(doc) || isA2aMessage(doc)`, so the `ap2` predicate is a strict logical SUBSET of the `a2a`
 *    one: every document the AP2 row fires on fires the A2A row too, without exception and by construction.
 *    So NO AP2 document is reachable through {@link parseProposalUniversal} — the ambiguity refusal always
 *    triggers first, and registering an `ap2` entry in {@link PROPOSAL_PARSERS} would not make one parseable.
 *    A caller holding an AP2 envelope names `ap2` and calls its parser directly. That is a consequence of AP2
 *    defining no transport of its own (v0.2 rides A2A), not a defect to engineer away: a negative term on the
 *    A2A row would be this package asserting that a valid A2A message is not one, which is A2A's call to
 *    make rather than ours — the host protocol defines its own documents.
 *
 * ORDERED as `KNOWN_PROTOCOL_IDS` orders the closed set, so `matchProtocols` reports in a stable order rather
 * than in the order units happened to land.
 */
export const PROTOCOL_DISCRIMINANTS: readonly ProtocolDiscriminant[] = [
  {
    protocol: "x402",
    kind: "structural",
    matches: (doc) =>
      typeof readAtPath(doc, "x402Version") === "number" &&
      isArrayAt(doc, "accepts"),
    cite: "x402 v2 PaymentRequired — `x402Version` plus the `accepts` requirement array (coinbase/x402 specs/x402-specification-v2.md §5.1.2, read 2026-07-30)",
  },
  {
    protocol: "mpp",
    kind: "undiscriminable",
    reason:
      "The document `placement-mpp` operates on is the DECODED `request` auth-param body, whose members are `amount` and `currency` (both REQUIRED strings, §5.1.1) plus optional `recipient`, `description`, `externalId` and `methodDetails` (§5.1.2). Not one of them names MPP, and an amount/currency pair is the shape of almost every payment document there is. MPP's identity lives one layer OUT, in the `WWW-Authenticate: Payment` challenge's auth-params (`realm`, `method`, `id`, `request`, `expires`, `digest`, `opaque`) — which is not the document the placement reads, so a caller holding a decoded request body must name `mpp` itself. Note `expires` is an auth-param ONLY: §5.1.2 states that expiry is conveyed in the challenge and that request objects MUST NOT duplicate it, so a body carrying one is malformed rather than discriminating.",
    cite: "MPP charge intent draft-payment-intent-charge-00 §5.1.1 Table 2 (required: amount, currency) and §5.1.2 Table 3 (optional: recipient, description, externalId, methodDetails) (mpp.dev/intents/charge, read 2026-07-30)",
  },
  {
    protocol: "ap2",
    kind: "structural",
    // AP2's own half first, A2A's second: the mandate DataPart is what makes this AP2 rather than any other
    // A2A message, and asking it first is also what keeps the `parts`-is-an-array guard a reachable branch
    // instead of one another predicate has already made true.
    //
    // This conjunction is a strict subset of the `a2a` row's disjunction, so the two ALWAYS co-fire — see the
    // table docblock. `ap2` is therefore a detect-and-name row, never a dispatchable one.
    matches: (doc) => carriesAp2Mandate(doc) && isA2aMessage(doc),
    cite: "AP2 v0.2 defines no transport; its reference samples carry mandates as A2A DataParts keyed `ap2.mandates.CheckoutMandateSdJwt` / `ap2.mandates.PaymentMandateSdJwt`, and the reference rides the A2A envelope's `metadata` beside them (placement-ap2 specification gate discharged 2026-07-30)",
  },
  {
    protocol: "ack",
    kind: "structural",
    matches: (doc) => {
      const types = readAtPath(doc, "type");
      return (
        Array.isArray(types) &&
        types.includes("PaymentReceiptCredential") &&
        isRecord(readAtPath(doc, "credentialSubject"))
      );
    },
    cite: 'ACK-Pay `createPaymentReceipt` mints a W3C credential typed ["VerifiableCredential", "PaymentReceiptCredential"] with a `credentialSubject` (agentcommercekit/ack packages/ack-pay/src/create-payment-receipt.ts + packages/vc/src/create-credential.ts, read 2026-07-30)',
  },
  {
    protocol: "acp",
    kind: "structural",
    matches: (doc) =>
      stringAtIsOneOf(doc, "status", ACP_SESSION_STATUS) &&
      isStringAt(doc, "currency") &&
      isArrayAt(doc, "totals") &&
      isArrayAt(doc, "line_items"),
    cite: "ACP agentic checkout (stable 2026-04-17) — `status` is REQUIRED on `CheckoutSessionBase` and is a closed eleven-value enum absent from all three request schemas; `currency`, `totals` and `line_items` are its siblings (enum enumerated live 2026-07-30, see placement-acp's write condition)",
  },
  {
    protocol: "ucp",
    kind: "structural",
    matches: (doc) =>
      isRecord(readAtPath(doc, "ucp")) &&
      isStringAt(doc, "id") &&
      isStringAt(doc, "status") &&
      isArrayAt(doc, "links"),
    cite: "UCP checkout response — `ucp` (the UCP metadata object), `id`, `status` and `links` are all REQUIRED, and `ucp` is the member no other protocol in the set carries (ucp.dev/latest/specification/checkout, read 2026-07-30)",
  },
  {
    protocol: "visa-tap",
    kind: "structural",
    matches: (doc) => {
      const signatureInput = readFromContainer(
        doc,
        { kind: "header-map" },
        "headers.signature-input",
      );
      return (
        typeof signatureInput === "string" &&
        TAP_SIGNATURE_TAGS.some((tag) => signatureInput.includes(`"${tag}"`))
      );
    },
    cite: "Visa TAP agent recognition signature — an RFC 9421 `Signature-Input` whose `tag` parameter is `agent-browser-auth` or `agent-payer-auth` (placement-visa-tap specification gate discharged 2026-07-30)",
  },
  {
    protocol: "mastercard-vi",
    kind: "structural",
    matches: (doc) =>
      stringAtIsOneOf(doc, "vct", VI_OPEN_MANDATE_VCT) &&
      isArrayAt(doc, "constraints"),
    cite: "Verifiable Intent — `constraints` appears in Autonomous-mode open mandates only, whose `vct` is `mandate.checkout.open.1` or `mandate.payment.open.1` (placement-mastercard-vi specification gate discharged 2026-07-30)",
  },
  {
    protocol: "a2a",
    kind: "structural",
    matches: (doc) => isA2aTask(doc) || isA2aMessage(doc),
    cite: "A2A — `Task` REQUIRES `id` and `status`, `Message` REQUIRES `messageId`, `role` and `parts`; both carry the free-form `metadata` map this placement writes (a2aproject/A2A specification/a2a.proto @ main, read 2026-07-30)",
  },
];

/**
 * Every protocol whose discriminant this document satisfies, in the table's order.
 *
 * ALL matches, never the first. A first-match detector cannot tell a document that belongs to one protocol
 * from a document that belongs to two, and the second case is the one that costs a buyer money: an AP2
 * envelope IS an A2A message, so both rows fire on it, and answering "a2a" because it came first would be a
 * guess wearing an answer's clothes.
 */
export function matchProtocols(wire: unknown): readonly ProtocolId[] {
  const matched: ProtocolId[] = [];
  for (const row of PROTOCOL_DISCRIMINANTS) {
    if (row.kind === "structural" && row.matches(wire))
      matched.push(row.protocol);
  }
  return matched;
}

/**
 * Identify which commerce protocol a wire document belongs to, structurally.
 *
 * Returns `undefined` unless EXACTLY ONE discriminant fires — so both "nothing matched" and "several matched"
 * answer `undefined`, because a single-valued return cannot honestly distinguish them and inventing a
 * preference is the failure this function exists to prevent. A caller that needs to tell the two apart calls
 * {@link matchProtocols} and reads the length; {@link parseProposalUniversal} does exactly that, and refuses
 * each case with its own message.
 *
 * This function never guesses and never throws.
 */
export function detectProtocol(wire: unknown): ProtocolId | undefined {
  const matched = matchProtocols(wire);
  return matched.length === 1 ? matched[0] : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// The universal LCP read — dispatched through the placement registry
// ---------------------------------------------------------------------------------------------------------

/**
 * The terms URL a document advertises at the path its manifest declares — or the reason there is no answer,
 * stated rather than folded into an `undefined`.
 *
 * A UNION, because `string | undefined` conflated three facts and only two of them are absences. The third is
 * x402 today: `PlacementManifest.termsUrlField` is SINGULAR, and x402's names a path INSIDE the
 * `extensions.legalContext.info` carrier — while the challenge LCP v1.38 §C.4 illustrates carries both the
 * reference and the URL in `accepts[].extra` instead, which the manifest declares as a `readAlso` alias. Read
 * such a challenge and the hash answers from the alias while the declared terms path holds nothing. That is
 * not "this seller advertised no terms"; it is "the manifest says nothing about where a terms URL rides on the
 * carrier that answered". Returning `undefined` there would assert the seller's silence — and
 * `parseProposalFromChallenge`, reading the same bytes in the same package, would contradict it.
 *
 * The gap is owed back to the manifest: a per-alias terms-URL declaration is the fix and it is a protocol-repo
 * change. Until it lands this type REPORTS the gap, because a reader that cannot tell two facts apart must say
 * which one it cannot tell.
 */
export type AdvertisedTermsUrl =
  /** Read from the field the manifest declares. */
  | { readonly kind: "read"; readonly url: string }
  /** The manifest declares no terms-URL field at all: the protocol has no room for one. */
  | { readonly kind: "no-field-declared" }
  /** The manifest declares one, its declaration reaches the answering carrier, and the document leaves it empty. */
  | { readonly kind: "declared-field-empty"; readonly field: string }
  /**
   * The manifest's terms-URL path lies INSIDE the canonical carrier's own object, and the reference answered
   * from a declared alias instead — so the declaration never reached the carrier this document used. Whether
   * the document advertises a terms URL is UNKNOWN to this reader, not answered.
   */
  | {
      readonly kind: "undeclared-at-answering-carrier";
      readonly field: string;
      readonly answeredAt: string;
    };

/** What a protocol document advertises about the terms governing it. */
export type AdvertisedTerms = {
  /** The protocol whose manifest the carriers were read through. */
  readonly protocol: ProtocolId;
  /** The advertised ATR hash, reconciled across every integrity-bearing carrier the manifest declares. */
  readonly advertisedAtrHash: `0x${string}`;
  /** What the document says about where its terms live — read, absent, or not answerable from here. */
  readonly legalContextUrl: AdvertisedTermsUrl;
};

/** One carrier slot a manifest declares, flattened so the canonical field and its aliases read alike. */
type CarrierSlot = {
  readonly path: string;
  readonly container: PlacementContainer;
  readonly encoding: PlacementEncoding;
  readonly carrierClass: CarrierClass;
  readonly carrierTypes: readonly LegalContextRef["type"][];
};

/**
 * The canonical field plus every declared alias, each flattened into a one-field manifest of its own.
 *
 * A SLOT IS A MANIFEST, so the actual reading is `readDeclaredPaths` — the same function, once per declared
 * path, rather than a second decoder that has to be kept honest by review. Only the INHERITANCE rules are
 * restated (an alias takes the manifest's container and encoding unless it declares its own, and is
 * `integrity` unless it says otherwise), because binding-core resolves those inside the first-hit-wins loop a
 * buyer cannot use. Everything downstream of a resolved slot — the `bare-value` type coming from
 * `carrierTypes[0]`, the wrapping into the §8.1 codec, the corrupt-value throw — stays where it was written.
 *
 * A declared `bareType` becomes the slot's WHOLE `carrierTypes`, which is the same thing said in the shape
 * this call takes: a bare value carries no type tag, so its type is whatever its one-field contract fixes.
 */
function carrierSlots(manifest: PlacementManifest): readonly CarrierSlot[] {
  const canonical: CarrierSlot = {
    path: manifest.field,
    container: manifest.container,
    encoding: manifest.encoding,
    carrierClass: "integrity",
    carrierTypes: manifest.carrierTypes,
  };
  return [
    canonical,
    ...(manifest.readAlso ?? []).map(
      (alias): CarrierSlot => ({
        path: alias.path,
        container: alias.container ?? manifest.container,
        encoding: alias.encoding ?? manifest.encoding,
        carrierClass: alias.carrierClass ?? "integrity",
        carrierTypes:
          alias.bareType === undefined
            ? manifest.carrierTypes
            : [alias.bareType],
      }),
    ),
  ];
}

/**
 * The reference each declared INTEGRITY carrier actually holds, with the path it was read from.
 *
 * Discovery-class slots are skipped before they are read, not after: UCP's `links[type=terms_of_service].url`
 * locates the terms without attesting to them — LCP v1.38 §C.3 files UCP's `links` under "discovery without
 * integrity" and says a standing policy page "is not a per-transaction terms record and carries no hash",
 * which is exactly why one cannot stand in for the other. Reading
 * it and discarding it later would also mean decoding a URL under the capability field's `sha256` contract,
 * which is a corrupt carrier and throws.
 */
function integrityHits(
  doc: unknown,
  manifest: PlacementManifest,
): readonly { readonly path: string; readonly ref: LegalContextRef }[] {
  const hits: { path: string; ref: LegalContextRef }[] = [];
  for (const slot of carrierSlots(manifest)) {
    if (slot.carrierClass !== "integrity") continue;
    const read = readDeclaredPaths(doc, {
      field: slot.path,
      container: slot.container,
      encoding: slot.encoding,
      carrierTypes: slot.carrierTypes,
    });
    if (read === undefined) continue;
    const ref = decodeDeclaredRead(read);
    if (ref === undefined) continue;
    hits.push({ path: slot.path, ref });
  }
  return hits;
}

/** Two references are the same reference iff type and value agree — hex compared case-insensitively. */
function carrierKey(ref: LegalContextRef): string {
  return ref.type === "sha256"
    ? `sha256:${ref.value.toLowerCase()}`
    : `${ref.type}:${ref.value}`;
}

/**
 * Read what ANY supported protocol document advertises: its ATR hash, and its terms URL where the protocol
 * has room for one.
 *
 * UNIVERSAL BY CONSTRUCTION. The carriers are not listed here — they are read out of the protocol's own
 * `PlacementManifest` through `@integraledger/lcp-placements`, so a protocol this function supports is precisely
 * one the build can also place a reference INTO, and adding a protocol product-side is nothing at all. There
 * is no second place protocols are listed and no path by which a reader and a writer can drift.
 *
 * THE PROTOCOL IS AN ARGUMENT, NOT A DETECTION. Detection is the only part of this seam that can be wrong, so
 * a caller that knows its protocol — which is the ordinary case, since a buyer agent knows which counterparty
 * it dialled — never pays for it. {@link detectProtocol} is available for the caller that genuinely does not.
 *
 * FAIL-FAST, four ways, all loud:
 *
 *  - a protocol with no registered placement (`mcp` is the only one, and LCP v1.38 §C.9 makes that terminal:
 *    it describes an LCP-aware MCP *server*, which has no document field for a reference to ride in);
 *  - a document advertising nothing at any declared carrier;
 *  - DISAGREEMENT between two declared carriers. This is the generalization of the x402 two-carrier rule to
 *    every protocol in the set, and it is deliberately stricter than the placement adapter's own `extract`,
 *    which answers with the canonical field and says nothing (`readDeclaredPaths` returns the first hit, not
 *    the set). A placement is structural and does not adjudicate a host's document; a BUYER must, because two
 *    different values on one document would let a seller advertise different terms to different readers of it
 *    and then disown whichever one it lost by. Preference is not an answer here — refusal is;
 *  - a reference that is not a `sha256` carrier. `carrierTypes` permits `url` on several manifests and that is
 *    correct for a placement, but the gate compares the advertised value against a RECOMPUTED record hash, and
 *    nothing but a hash can be compared to a hash.
 *
 * `deployment` is required only for a protocol whose placement is namespaced — Mastercard VI, whose constraint
 * type is minted under the deployment's own reverse-domain namespace and has no default. Omitting it there
 * throws from the registry rather than answering about some invented namespace.
 */
export function readAdvertisedTerms(
  protocol: ProtocolId,
  wire: unknown,
  deployment?: PlacementDeployment,
): AdvertisedTerms {
  const placement = placementFor(protocol, deployment);
  if (placement === undefined)
    throw new Error(
      `no placement is registered for ${protocol} — this build cannot read a reference out of its documents`,
    );
  const manifest = placement.manifest;

  const hits = integrityHits(wire, manifest);
  const sole = hits[0];
  if (sole === undefined) {
    const looked = carrierSlots(manifest)
      .filter((slot) => slot.carrierClass === "integrity")
      .map((slot) => slot.path)
      .join(", ");
    throw new Error(
      `${protocol} document advertises no LCP reference at any declared integrity carrier (${looked})`,
    );
  }

  const distinct = new Set(hits.map((hit) => carrierKey(hit.ref)));
  if (distinct.size > 1)
    throw new Error(
      `${protocol} carriers disagree — ${hits
        .map(
          (hit) =>
            `${hit.path} advertises lcp:${hit.ref.type}:${hit.ref.value}`,
        )
        .join(", ")}`,
    );

  const ref = sole.ref;
  if (ref.type !== "sha256")
    throw new Error(
      `${protocol} advertises an lcp:${ref.type}: reference; the gate compares the advertised value against a recomputed record hash, which only a sha256 carrier can be`,
    );

  return {
    protocol,
    advertisedAtrHash: ref.value as `0x${string}`,
    legalContextUrl: readTermsUrl(protocol, wire, manifest, sole.path),
  };
}

/**
 * The terms URL at the field the manifest DECLARES — or which of the three absences this is.
 *
 * `termsUrlField` is a plain dotted path on the manifest: it declares no container of its own, so it is read
 * with `readAtPath` rather than through the reference carrier's container. A manifest that omits it (A2A, ACK,
 * Visa TAP, Mastercard VI) is stating that its protocol has no room for one — a fact, not a gap.
 *
 * NOTHING AT THE DECLARED PATH IS TWO DIFFERENT FACTS, and which one it is turns on where the reference
 * answered from. `termsUrlField` is declared once, beside the canonical `field`; a `readAlso` alias carries no
 * terms-URL declaration of its own. So when the declared path is nested INSIDE the canonical field — x402's
 * `extensions.legalContext.info.legalContextUrl` inside `extensions.legalContext.info` — and the reference
 * answered from an alias instead, the manifest's declaration was scoped to a carrier this document did not
 * use, and its emptiness says nothing about the document. When the declared path is a SIBLING of the canonical
 * field (ACP's `metadata.legal_context_url`, MPP's `methodDetails.legalContextUrl`), it is reachable whichever
 * carrier answered, and empty means empty.
 *
 * `answeredAt` is the path the reconciled reference was read from. `carrierSlots` puts the canonical field
 * first and `integrityHits` preserves that order, so it differs from `manifest.field` exactly when the
 * canonical carrier did not answer.
 */
function readTermsUrl(
  protocol: ProtocolId,
  doc: unknown,
  manifest: PlacementManifest,
  answeredAt: string,
): AdvertisedTermsUrl {
  const field = manifest.termsUrlField;
  if (field === undefined) return { kind: "no-field-declared" };
  const raw = readAtPath(doc, field);
  if (raw === undefined)
    return answeredAt !== manifest.field &&
      field.startsWith(`${manifest.field}.`)
      ? { kind: "undeclared-at-answering-carrier", field, answeredAt }
      : { kind: "declared-field-empty", field };
  if (typeof raw !== "string")
    throw new Error(
      `${protocol} ${field} is not a string: ${JSON.stringify(raw)}`,
    );
  if (!raw.startsWith("https://"))
    throw new Error(`legalContextUrl must be HTTPS: ${raw}`);
  return { kind: "read", url: raw };
}

// ---------------------------------------------------------------------------------------------------------
// The universal gate parse
// ---------------------------------------------------------------------------------------------------------

/** A parser from one protocol's wire document to the one `GateProposal` every parser produces. */
export type ProposalParser = (
  wire: unknown,
  ctx: ProposalContext,
) => GateProposal;

/**
 * Every protocol this build can turn into a complete `GateProposal`, keyed by `ProtocolId`.
 *
 * SMALLER THAN THE PLACEMENT REGISTRY, and the difference is a fact about the protocols rather than a gap in
 * this package. A `GateProposal` carries an OFFER — an amount and a unit — and an offer is protocol-native
 * economics that no `PlacementManifest` declares and LCP does not standardize: x402 quotes it in
 * `accepts[].amount` with a `network:asset` unit, ACP in the row of `totals` typed `total` with an ISO 4217
 * currency, and the remaining seven each differently again. Inventing an offer-locator axis product-side would
 * put protocol knowledge in a second place and put it there UNGATED, which is the one thing the placement seam
 * was built to stop. {@link readAdvertisedTerms} is universal because the reference is; this is not, because
 * the offer is not.
 *
 * ONE PROTOCOL COULD NOT BE DISPATCHED HERE EVEN IF ITS OFFER WERE READABLE. `ap2`'s discriminant is a strict
 * subset of `a2a`'s, so an AP2 envelope always matches two rows and {@link parseProposalUniversal} refuses it
 * as ambiguous before any lookup in this map. An `ap2` entry added here would be unreachable through the
 * universal door; the parser a future unit writes must be exported and called by name.
 *
 * `Object.freeze` for the same reason `PLACEMENTS` is frozen: a published package is consumed as JavaScript,
 * where the type alone does not stop a consumer swapping the parser that decides what a buyer is agreeing to.
 */
export const PROPOSAL_PARSERS: Readonly<
  Partial<Record<ProtocolId, ProposalParser>>
> = Object.freeze({
  x402: parseProposalFromChallenge,
  acp: parseProposalFromAcpCheckout,
});

/** Every protocol this build can parse a complete proposal from, in registration order. */
export function parseableProtocols(): readonly ProtocolId[] {
  return Object.keys(PROPOSAL_PARSERS) as ProtocolId[];
}

/**
 * Parse ANY supported wire into the one `GateProposal` every parser produces.
 *
 * The universal entry point: a buyer no longer has to know which protocol it is on to gate a
 * transaction. Every named parser stays exported — a caller that DOES know its protocol should keep calling
 * the specific one, because a known protocol needs no detection and detection is the only part that can be
 * wrong.
 *
 * Fail-fast on four conditions, all loud: an unidentifiable wire, an AMBIGUOUS wire matching more than one
 * protocol's discriminant, a protocol whose offer this build cannot read, and any refusal from the protocol
 * parser it routes to. There is no "try them all and take the first that works" path — that is a fallback
 * chain, and it would let a malformed document of one protocol be silently reinterpreted as a valid document
 * of another.
 *
 * The named parsers are DELEGATED to rather than reimplemented over the placement manifests, and one of them
 * proves why that is not merely convenient: x402's wire carries `legalContextUrl` in BOTH `accepts[].extra`
 * and `extensions.legalContext.info` — LCP v1.38 §C.4's own illustration uses the first — while
 * `PlacementManifest.termsUrlField` is singular and declares only the second. Routing x402 through the
 * manifest would drop the terms URL from a spec-legal challenge. The reference reconcile generalizes; the
 * terms-URL locator does not yet, so this entry point delegates and {@link readAdvertisedTerms} REPORTS the
 * shortfall as `undeclared-at-answering-carrier` rather than answering an absence it cannot vouch for.
 */
export function parseProposalUniversal(
  wire: unknown,
  ctx: ProposalContext,
): GateProposal {
  const matched = matchProtocols(wire);
  if (matched.length > 1)
    throw new Error(
      `ambiguous wire — it matches the discriminants of ${matched.length} protocols (${matched.join(", ")}); a document that is legitimately two protocols' documents is not resolved by preference, so name the protocol and call its parser directly`,
    );
  const protocol = matched[0];
  if (protocol === undefined)
    throw new Error(
      "could not identify which commerce protocol this document belongs to — no declared discriminant matched",
    );
  const parse = PROPOSAL_PARSERS[protocol];
  if (parse === undefined)
    throw new Error(
      `no buyer proposal parser for ${protocol} — this build parses ${parseableProtocols().join(", ")}. ${protocol} quotes its offer in a shape no placement manifest declares; readAdvertisedTerms("${protocol}", …) reads its LCP reference today`,
    );
  return parse(wire, ctx);
}

# @integraledger/lcp-mcp-server

## 0.10.0

### Minor Changes

- 06a25ac: Read the whole advertisement, and move to protocol 0.12.0.

  The peer range was `^0.10.1`, which on a `0.x` version admits only patches — so this guard declared it did
  not support the line every seller now writes, and a tree holding both resolved a second copy of the protocol
  packages to satisfy it. The peers are `^0.12.0` and the build pins 0.12.0 exactly.

  **The terms URL is no longer read by hand.** `PlacementManifest.termsUrlField` was singular and named one
  path; it is now `termsUrlFields`, plural, and a slot that rides a container the placement owns is declared on
  that container. Reading that by hand here would have been a second implementation of a manifest rule, so the
  locator now comes from the placement's own `extract`, which reconciles every declared slot and refuses two
  that disagree. The reference walk stays this package's own: "integrity carriers only" is a BUYER rule — a
  discovery link locates a standing page and attests nothing — and the placement's reader does not apply it.

  **`AdvertisedTermsUrl` loses a state, and could not keep it.** `undeclared-at-answering-carrier` existed
  because the singular member could not reach the carrier a §C.4 challenge actually used: the hash answered
  from `accepts[].extra` while the one declared path sat empty inside `extensions`, and reporting that as "no
  terms advertised" would have asserted a silence this reader could not see. With every slot declared and
  reconciled there is no such carrier, so the state is unreachable rather than merely unused, and the §C.4
  challenge now simply reads its URL. `declared-field-empty` becomes `declared-fields-empty` and carries every
  slot it looked at.

  `lcp_place_reference` takes an optional `termsUrl` — required where the protocol declares a slot and the
  reference is a digest, refused where it declares none — and `lcp_extract_reference` reports the locator
  beside the reference, with its two absences distinguished: a protocol with no slot is not a seller who left
  one empty.

  Wire identities are unchanged apart from the protocol line itself.

### Patch Changes

- Updated dependencies [06a25ac]
  - @integraledger/agent-guard@0.10.0

## 0.9.0

**First public release** — Apache-2.0, free forever, no account and no token to install.

`lcp-mcp-server` exposes read-only Legal Context Protocol tools to an AI agent over the Model Context
Protocol: verify before pay, compute an atrHash, and extract or place a terms reference across the nine
commerce protocols that have a defined placement.

### Six tools, all read-only

`lcp_verify_before_pay` · `lcp_compute_atrhash` · `lcp_extract_reference` · `lcp_place_reference` ·
`lcp_generate_legal_context` · `lcp_scaffold_integration`

Every tool declares `readOnlyHint` to the host. The annotations are stated rather than omitted because
MCP documents `destructiveHint` and `openWorldHint` as defaulting to **true** — an unannotated tool reads
to a client as possibly destructive and open to an arbitrary external world, which is the most alarming
reading available and not the honest one for this surface.

The **only** network egress is the counterparty terms fetch, and it goes through the same injected,
SSRF-guarded port the guard uses: HTTPS-only, no redirects, public-unicast re-checked on every fetch, and
a streaming byte cap. Nothing calls home.

### Wiring

Stdio transport for desktop agent hosts, served so that both current and `2026-07-28` clients resolve
correctly from one registration. Built against the live MCP `ToolAnnotations` definition
(`schema/2026-07-28/schema.ts`); the specification check behind that date is recorded in this package's
README.

### Packaging

- Apache-2.0. LICENSE and NOTICE ship in the tarball; NOTICE states the trademark reservation, names
  Integra Ledger and AAA-ICDR as the Legal Context Protocol's co-stewards, and records that the
  seller-side application is separately licensed and not part of this distribution.
- Consumed as a runnable server over `npx`, so the `@integraledger/lcp-*` protocol line and
  `@integraledger/agent-guard` are ordinary exact dependencies — there is no second line for it to
  collide with.
- `files` ships `src` alongside `dist`, so published source maps resolve inside the tarball.

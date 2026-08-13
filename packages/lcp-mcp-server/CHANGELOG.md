# @integraledger/lcp-mcp-server

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

# @integraledger/agent-guard

## 0.9.0

**First public release** — Apache-2.0, free forever, no account and no token to install.

`agent-guard` is the buyer-side verify-before-sign guard for agentic purchases. It fetches the terms a
seller advertised, recomputes their fingerprint, and halts before any signing key is invoked if the two
disagree. It works against **any** seller, whether or not that seller uses Integra software.

### The gate

`evaluate` runs the Legal Context Protocol's buyer sequence and returns a decision. It never touches a
signing key itself — `transact` enforces the decision against a guarded signer, so no caller can sign on a
refusal by mistake.

- **Fetch and retain the terms as evidence** (LCP §5.4), at every trust level, never a silent skip.
- **Verify before sign** (LCP §5.3): recompute the fingerprint over the fetched bytes and HALT on a
  mismatch, before the key.
- **Policy on the typed envelope only** (LCP §12.7). The terms body is retained as evidence and never
  reaches policy evaluation. The prompt-injection boundary is architectural rather than a filter: the
  typed proposal cannot carry prose.
- **Refuse rather than choose.** A coverage gap resolves by the buyer's stated disposition; nothing
  resolves by a silent default.

Outcomes are **twelve decline codes**, plus `gate/escalate` and `gate/proceed`. The codes are the
contract — the accountable record and a buyer's escalation path both key off them — and a refusal names
the counterparty's actual defect rather than a reason that merely happens to be true. A counterparty
cannot make the gate throw: every failure reachable from a seller-authored document arrives as a returned
decision.

### Protocols

Four commerce protocols parse into one typed `GateProposal`: **x402** and **ACP** through
`parseProposalUniversal`, which refuses a document matching two protocols' discriminants rather than
picking one; **AP2** and **MPP** by name, because their identity lives outside the body a caller holds.

### The fetcher is an SSRF boundary

It takes a counterparty-chosen URL. It is HTTPS-only, refuses redirects, re-checks that every resolved
address is public unicast on every fetch, and caps the body while streaming. IPv6-literal hosts are
supported. `GatePorts` is a documented trust boundary: the fetcher decides which bytes the fingerprint is
recomputed over.

**Nothing calls home** — no telemetry, no callback, no request beyond fetching the terms the seller
pointed at.

### Packaging

- Apache-2.0. LICENSE and NOTICE ship in the tarball; NOTICE states the trademark reservation, names
  Integra Ledger and AAA-ICDR as the Legal Context Protocol's co-stewards, and records that the
  seller-side application is separately licensed and not part of this distribution.
- The `@integraledger/lcp-*` protocol line is a **peer** dependency, so a consumer's tree holds exactly
  one copy of it — two copies break `instanceof` across the boundary.
- `files` ships `src` alongside `dist`, so published source maps resolve inside the tarball.
- Runs on Node, Deno, Bun, and Workers with `nodejs_compat`. The README's runtime table states per-target
  support exactly; the one Node-specific host lookup is lazily imported and injectable.

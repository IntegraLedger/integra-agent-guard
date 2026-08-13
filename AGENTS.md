# integra-agent-guard — agent instructions

Two packages, both **public, Apache-2.0, free forever and never monetized**: `agent-guard`, the buyer-side
verify-before-sign guard, and `lcp-mcp-server`, its Model Context Protocol packaging. Anything that makes
either harder to install is a defect, not a hardening measure. Both work against any seller.

Consumes the Legal Context Protocol's public `@integraledger/lcp-*` packages from npmjs, exact-pinned. The
separately licensed seller-side application is **not** part of this repository and nothing here may depend
on it — `check:public-boundary` refuses any `@integraledger/*` dependency that is neither a workspace
sibling nor on the `lcp-*` line, because such a dependency resolves in a private workspace and breaks only
for the first stranger to `npm install`, after the version is burned.

pnpm 11 workspace, Node ≥ 24, TypeScript with `isolatedDeclarations`.

## Gates

```
pnpm verify  =  check:versions → check:wire → check:public-boundary → check:vocab → audit → build → lint
                → typecheck → check:docs → test
pnpm mutation <pkg>            (STRYKER_PKG required; ratchets in stryker.config.mjs — raise, never lower)
```

`pnpm verify` is not hermetic — the audit stage fails on any newly published advisory against an unchanged
tree. If only that stage fails: record the advisory, run the rest explicitly, proceed, triage separately.
Never weaken the threshold.

## Rules

- **The protocol dependency is pinned, and the pin is the contract.** Repin deliberately with a changeset;
  a repin is a release, not a chore. Pins are exact, everywhere — two copies of `lcp-binding-core` in one
  tree break `instanceof CarrierError`, and a caret is how a second copy gets in.
- **Refuse ambiguity rather than choosing.** `parseProposalUniversal` refuses when two protocols match;
  a step's four-valued status maps totally onto a disposition; gaps resolve by the buyer's stated policy,
  never by a silent default. Preserve this — it is load-bearing.
- **The typed proposal cannot carry natural-language prose.** The prompt-injection boundary is
  architectural: the terms body can never reach policy evaluation. Nothing may widen the proposal type in
  a way that admits prose.
- **The security claims in the READMEs are enforced claims.** HTTPS-only, `redirect: "error"`, public
  unicast re-checked on every re-fetch, a streaming byte cap with a declared-length pre-check; the MCP
  tools are read-only and declare `readOnlyHint`; nothing calls home. A change that weakens any of these
  is a behaviour change to a published guarantee, not a refactor.
- **Changesets for anything publishable.** Both packages version independently — there is no fixed group;
  changesets bumps the dependent through `workspace:*`.

## Publishing

Steady state is trusted publishing from CI — no long-lived token. The **first** release of any new package
name cannot use it: npm can neither configure trusted publishing for a name that has never been published
nor stage a brand-new name, so a new name needs a one-time token-gated publish, run **from GitHub Actions,
never from a laptop** — provenance is minted at publish time by the workflow's OIDC identity, an npm
version can never be reused, and a laptop publish leaves that version permanently unattested.

After any publish, verify against the version-specific endpoint
(`registry.npmjs.org/<pkg>/<version>`) — `npm view` and the full packument can lag a fresh publish and
report a successful release as absent.

## Layout

`agent-guard` — the guard: typed proposal, policy evaluation, mechanical verification, universal parsing ·
`lcp-mcp-server` — six read-only MCP tools over the same kernel, plus stdio wiring for desktop agent hosts.

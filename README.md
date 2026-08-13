# Integra Agent Guard

The buyer/developer side of Legal Context Protocol commerce. Two packages, **Apache-2.0, free forever —
no account, no key, no token, nothing to sign up for.**

| Package | What it is |
|---|---|
| [`@integraledger/agent-guard`](packages/agent-guard) | Verify before sign, as a type and as a runtime guarantee. A paying agent fetches the terms the seller advertised, recomputes the fingerprint, and halts before any signing key is invoked if they disagree. |
| [`@integraledger/lcp-mcp-server`](packages/lcp-mcp-server) | Read-only Model Context Protocol server exposing LCP tools to an AI agent — verify before pay, compute an atrHash, extract and place references across the nine commerce protocols that have one. |

```bash
npm install @integraledger/agent-guard
npm install @integraledger/lcp-mcp-server
```

Both work against **any** seller — the checks run over what a seller publicly advertises, so they are
useful whether or not that seller has ever heard of Integra. Nothing here calls home: no telemetry, no
callback, no network request other than fetching the terms the seller pointed you at.

## The standard

The [Legal Context Protocol](https://legalcontextprotocol.org/standard) is co-stewarded by Integra Ledger
and AAA-ICDR. These packages implement its buyer side over the public
[`@integraledger/lcp-*`](https://www.npmjs.com/search?q=%40integraledger%2Flcp) protocol packages. The
seller-side application they interoperate with is separately licensed and is not part of this repository.

## Developing

pnpm 11 workspace, Node ≥ 24.

```bash
pnpm install
pnpm verify          # versions → wire → public-boundary → audit → build → lint → typecheck → docs → test
pnpm mutation agent-guard
```

See [AGENTS.md](AGENTS.md) for the gates and the constraints that outlive any one change.

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for trademark and stewardship statements.

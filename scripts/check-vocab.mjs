#!/usr/bin/env node
/**
 * Refuse any identifier-shaped referent that a stranger cannot resolve.
 *
 * WHY THIS EXISTS. This repository is public, and CLAUDE.md already states the rule: no internal
 * vocabulary. A rule stated in prose and enforced by nobody drifts — internal identifiers were swept out
 * of shipped source once, and survived in `stryker.config.mjs` and three test files, because the sweep was
 * a person reading rather than a gate running. The published packages carry docblocks into `dist/*.d.ts`
 * and ship `src`, so an identifier like `U1` reaches a reader who has no possible way to look it up. An
 * unresolvable referent is worse than no referent: it tells the reader that something authoritative exists
 * and withholds it.
 *
 * WHAT COUNTS AS RESOLVABLE. Exactly two things, both of which a stranger can actually obtain:
 *
 *   1. Anything the PUBLISHED `@integraledger/lcp-*` packages already use. Those are on npmjs, they are a
 *      declared dependency of this repository, and the protocol identifiers they define (`IDN-3`, `ATA-2`,
 *      `ORC-4`, the `TC-*` class ladder, `R-8`, …) are public vocabulary by construction. Deriving this set
 *      by MEASUREMENT rather than by hand means it tracks the protocol line automatically: repin, and the
 *      allowed set moves with it.
 *   2. Standards vocabulary whose prefix is a public registry (`SHA-256`, `EIP-3009`, `CAIP-2`, `P-256`).
 *
 * Everything else is a finding. Note what is deliberately NOT a resolver: this repository's own READMEs.
 * Letting a token resolve because it appears in our own prose is circular — mentioning `U1` in a README
 * does not define it, and the standard is that a referent resolves for a stranger, not that it is written
 * down twice.
 *
 * THE SCAN IS RECURSIVE, AND THAT IS LOAD-BEARING. A sibling gate once scanned `src` with a
 * non-recursive `readdirSync` and reported clean while six files in `src/tools/` were invisible to it. A
 * filter that silently matches nothing is indistinguishable from a clean result, which is why this file
 * ends by proving it can still see — see the canaries.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * pnpm materialises `node_modules/@scope/name` as a SYMLINK into the content-addressed store, and
 * `Dirent.isDirectory()` is FALSE for a symlink. Following the link is therefore not an optimisation — a
 * bare `isDirectory()` walk reads zero files here and, without the fail-loud guard below, would have
 * reported an empty resolvable set as a clean pass.
 */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".turbo",
  "reports",
  "stryker-tmp",
]);
const SCAN_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".md",
  ".yml",
  ".yaml",
]);

/** Identifier shapes that internal tracker IDs actually take: `H-1`, `TRM-5`, `R-8.1`, and bare `U1`. */
const CANDIDATE = /\b(?:[A-Z][A-Za-z]{0,5}-\d+(?:\.\d+)?|[A-Z]\d{1,2})\b/g;

/** Prefixes owned by a public standards body — any numeric suffix under them resolves. */
const STANDARD_PREFIXES = new Set([
  "SHA",
  "EIP",
  "ERC",
  "CAIP",
  "RFC",
  "BIP",
  "ISO",
  "UTF",
  "TLS",
  "HTTP",
  "AES",
  "RSA",
  "SEC",
  "ES",
  "RS",
  "PS",
  "HS",
  "P",
  "K",
  "X",
  "CVE",
  "GHSA", // advisory identifiers, cited when a dependency is pinned or overridden
]);

/**
 * Machine-generated files are not prose and have no referents. The lockfile's base64 integrity hashes
 * contain runs like `Y4` and `E8` that match the identifier shape by pure coincidence.
 */
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

/**
 * Tokens that are neither protocol vocabulary nor a standards prefix, but are still resolvable for a
 * reader. Each needs a reason, because an unexplained entry here is how a gate is quietly widened until it
 * matches nothing.
 */
const ALLOW = new Map([
  ["H2", "HTTP/2, named in transport prose"],
  ["S3", "AWS S3, named as an example object store"],
]);

/** Literal markers that must never appear in a public repository, whatever shape they take. */
const FORBIDDEN_LITERALS = [
  [/claude\.ai\/code\/session/i, "a Claude session URL"],
  [/Co-Authored-By:\s*Claude/i, "a Co-Authored-By trailer"],
  [/integra-agentic-commerce/i, "the private seller-side repository by name"],
];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (
      e.name.startsWith(".") &&
      e.name !== ".github" &&
      e.name !== ".changeset"
    )
      continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SCAN_EXT.has(extname(e.name)) && !SKIP_FILES.has(e.name)) yield p;
  }
}

function tokensIn(text) {
  return new Set(text.match(CANDIDATE) ?? []);
}

/** The published protocol line, read from the installed tree — measurement, not a hand-kept list. */
function protocolVocabulary() {
  const scope = join(ROOT, "node_modules", "@integraledger");
  if (!existsSync(scope))
    throw new Error(
      "check:vocab cannot read node_modules/@integraledger — the resolvable set would be empty and every " +
        "protocol identifier would report as a finding. Run `pnpm install` first. Refusing to run blind.",
    );
  const vocab = new Set();
  let filesRead = 0;
  for (const pkg of readdirSync(scope)) {
    const dir = join(scope, pkg);
    if (!isDir(dir)) continue;
    for (const f of walkAll(dir)) {
      const ext = extname(f);
      if (ext !== ".js" && ext !== ".ts" && ext !== ".md") continue;
      filesRead++;
      for (const t of tokensIn(readFileSync(f, "utf8"))) vocab.add(t);
    }
  }
  if (filesRead === 0)
    throw new Error(
      "check:vocab read ZERO files from the installed @integraledger packages. Refusing to run blind.",
    );
  return vocab;
}

function* walkAll(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (isDir(p)) yield* walkAll(p);
    else yield p;
  }
}

const PROTOCOL_VOCAB = protocolVocabulary();

function unresolvable(token) {
  if (PROTOCOL_VOCAB.has(token)) return false;
  if (ALLOW.has(token)) return false;
  const prefix = token.includes("-")
    ? token.slice(0, token.indexOf("-"))
    : token.replace(/\d+$/, "");
  return !STANDARD_PREFIXES.has(prefix);
}

// ---- canaries: prove the classifier still discriminates before trusting a clean result ----
const CANARIES = [
  ["U1", true, "a bare internal tracker id"],
  ["TRM-5", true, "a hyphenated internal id"],
  ["IDN-3", false, "public protocol vocabulary"],
  ["SHA-256", false, "a standards identifier"],
];
for (const [token, shouldFlag, what] of CANARIES) {
  if (!tokensIn(token).has(token))
    throw new Error(
      `check:vocab canary: the scan pattern no longer even matches ${token} (${what}).`,
    );
  if (unresolvable(token) !== shouldFlag)
    throw new Error(
      `check:vocab canary FAILED: ${token} (${what}) should ${shouldFlag ? "" : "NOT "}be flagged. ` +
        "The gate is not discriminating and a clean result would mean nothing.",
    );
}

// ---- the scan ----
const findings = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1);
  if (rel === "scripts/check-vocab.mjs") continue; // this file names the tokens it forbids
  const text = readFileSync(file, "utf8");
  scanned++;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const token of tokensIn(line))
      if (unresolvable(token))
        findings.push({
          rel,
          line: i + 1,
          what: `unresolvable identifier \`${token}\``,
        });
    for (const [re, what] of FORBIDDEN_LITERALS)
      if (re.test(line)) findings.push({ rel, line: i + 1, what });
  });
}

if (scanned === 0) {
  console.error(
    "check:vocab scanned ZERO files — the walk is broken. Refusing to report clean.",
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check:vocab — ${findings.length} referent(s) a stranger cannot resolve, across ${scanned} files:\n`,
  );
  for (const f of findings) console.error(`  ${f.rel}:${f.line} — ${f.what}`);
  console.error(
    "\nSay what the identifier stood for, rather than naming it. If it IS public, it belongs in the " +
      "protocol packages or in this script's ALLOW map with a reason.",
  );
  process.exit(1);
}

console.log(
  `check:vocab — ${scanned} files, every identifier resolvable (${PROTOCOL_VOCAB.size} from the protocol line), 4/4 canaries.`,
);

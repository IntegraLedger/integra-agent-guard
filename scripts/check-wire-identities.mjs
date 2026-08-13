#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
/**
 * Seal the protocol identities this guard reads off the wire, and refuse a peer range this repository has
 * never tested against.
 *
 * WHY A GATE AND NOT A TEST. The identities here are not this package's to choose. `com.integraledger.
 * legal_context`, `/.well-known/legal-context.json`, and the field each commerce protocol carries a
 * reference in are the Legal Context Protocol's, and a seller's writer matches on exactly the same values
 * this guard's reader does. They arrive from `@integraledger/lcp-*` at whatever version is installed, so a
 * dependency bump can change what this guard looks for without changing a line of code in this repository.
 *
 * A test suite cannot catch that, and the reason is structural rather than a gap in coverage: a fixture
 * asserting a constant is written against the same installed version the code reads it from, so both sides
 * of the assertion move together and the suite stays green through the change. Sealing the values in a file
 * that does NOT move with the dependency is what makes the change visible.
 *
 * WHAT THE SEAL MEANS. Every value in `wire-identities.seal.json` is one a counterparty already has to know
 * to interoperate with this guard. A diff here is therefore a change to what a seller must write for this
 * buyer to accept it — not a refactor, and not a version bump. Resealing with `pnpm seal:wire` is a
 * deliberate line in a diff a reviewer sees.
 *
 * THE PEER CHECK. This package takes the protocol line as a `peerDependency` so the consumer owns one copy
 * of it — two copies in one tree break `instanceof` across the boundary. That shifts a burden onto this
 * repository: the range is a promise about versions we do not install, and the only version we actually
 * exercise is the exact pin in `devDependencies`. So this refuses a peer without a matching dev pin, a dev
 * pin outside its own peer range, and dev pins that are not all one version. A range wider than what CI
 * runs is a claim this repository cannot support.
 *
 * Regenerate deliberately with `pnpm seal:wire`, never to make a build pass.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SEAL = join(root, "scripts", "wire-identities.seal.json");
const WRITE = process.argv.includes("--write");
const PROTOCOL = /^@integraledger\/lcp-/;
/** Fixed sentinel for building a `namespaced` placement, whose field is templated on a deployment's own
 *  reverse-domain namespace. The namespace is the deployment's; the SUFFIX is the protocol's. */
const SEAL_NAMESPACE = "dev.seal";

const fail = [];

const manifests = [
  ["<root>", join(root, "package.json")],
  ...readdirSync(join(root, "packages"))
    .map((d) => [d, join(root, "packages", d, "package.json")])
    .filter(([, p]) => existsSync(p)),
];

// WORKSPACE SIBLINGS ARE NOT THE PROTOCOL LINE, and the name prefix cannot tell them apart.
// `@integraledger/lcp-mcp-server` is published from this repository and matches `lcp-` exactly as
// `@integraledger/lcp-kernel` does. Without this, a sibling declared `workspace:*` — which is the correct
// way to declare one, and what the doc-snippet gate needs at the root so fences can resolve their own
// package — is refused for not being an exact version. Membership, never the prefix.
const WORKSPACE = new Set(
  manifests
    .filter(([name]) => name !== "<root>")
    .map(([, p]) => JSON.parse(readFileSync(p, "utf8")).name)
    .filter(Boolean),
);
const isProtocolDep = (dep) => PROTOCOL.test(dep) && !WORKSPACE.has(dep);

/* ---------- ONE: the exercised line is one line, and it satisfies every peer range ---------- */

/** `^1.2.3` / `~1.2.3` / `1.2.3` → is `exact` inside it? Caret and tilde only; no other syntax is used here. */
function satisfies(range, exact) {
  const [rMajor, rMinor, rPatch] = range
    .replace(/^[\^~]/, "")
    .split(".")
    .map(Number);
  const [eMajor, eMinor, ePatch] = exact.split(".").map(Number);
  if ([rMajor, rMinor, rPatch, eMajor, eMinor, ePatch].some(Number.isNaN))
    return false;
  const atLeast =
    eMajor > rMajor ||
    (eMajor === rMajor &&
      (eMinor > rMinor || (eMinor === rMinor && ePatch >= rPatch)));
  if (!atLeast) return false;
  if (range.startsWith("^"))
    return rMajor === 0 ? eMajor === 0 && eMinor === rMinor : eMajor === rMajor;
  if (range.startsWith("~")) return eMajor === rMajor && eMinor === rMinor;
  return range === exact;
}

const devLines = new Map(); // version -> [where]
for (const [name, path] of manifests) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([d]) =>
    isProtocolDep(d),
  );
  const devs = Object.fromEntries(
    Object.entries(pkg.devDependencies ?? {}).filter(([d]) => isProtocolDep(d)),
  );

  for (const [dep, exact] of Object.entries(devs)) {
    if (!/^\d+\.\d+\.\d+$/.test(exact)) {
      fail.push(
        `${name} → ${dep} is "${exact}" in devDependencies. The exercised version must be exact — it is the only one CI proves.`,
      );
      continue;
    }
    if (!devLines.has(exact)) devLines.set(exact, []);
    devLines.get(exact).push(`${name} → ${dep}`);
  }

  for (const [dep, range] of peers) {
    const exact = devs[dep];
    if (!exact) {
      fail.push(
        `${name} → ${dep} is a peer at "${range}" with no devDependency pin. Nothing installs it here, so the range is untested.`,
      );
      continue;
    }
    if (!satisfies(range, exact)) {
      fail.push(
        `${name} → ${dep}: devDependency ${exact} is outside the peer range "${range}". CI exercises a version a consumer cannot install.`,
      );
    }
  }

  // A protocol package imported by shipped source must be a peer, or a consumer's install is incomplete.
  const srcDir = join(root, "packages", name, "src");
  if (existsSync(srcDir)) {
    // RECURSIVE. A flat `readdirSync` saw only the top level, so `src/tools/*.ts` — where one package keeps
    // every one of its tool implementations — was invisible to the peer-declaration rule below. It passed
    // because that package happens to declare all nine protocol packages directly; it would have gone on
    // passing the day one of them became a transitive-only import, which is precisely the case this rule
    // exists to catch. A checker that cannot see a directory reports it clean.
    const tsFiles = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? tsFiles(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    const src = tsFiles(srcDir)
      .map((f) => readFileSync(f, "utf8"))
      .join("");
    const imported = new Set(
      [...src.matchAll(/"(@integraledger\/lcp-[a-z0-9-]+)"/g)]
        .map((m) => m[1])
        .filter(isProtocolDep),
    );
    const declared = new Set(peers.map(([d]) => d));
    for (const dep of imported) {
      if (!declared.has(dep) && !(pkg.dependencies ?? {})[dep]) {
        fail.push(
          `${name} imports ${dep} from src but declares it neither as a peer nor a dependency — a consumer's install would be missing it.`,
        );
      }
    }
  }
}

if (devLines.size > 1) {
  const detail = [...devLines.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([v, where]) => `    ${v}  (${where.length}) e.g. ${where[0]}`)
    .join("\n");
  fail.push(
    `the tree exercises ${devLines.size} protocol lines, and it must exercise one:\n${detail}`,
  );
}

const line = devLines.size === 1 ? [...devLines.keys()][0] : null;

/* ---------- TWO: the wire identities are sealed ---------- */

function resolveFrom(dep) {
  for (const [, path] of manifests) {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const declared = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ].some((f) => pkg[f]?.[dep]);
    if (!declared) continue;
    try {
      return createRequire(path).resolve(dep);
    } catch {
      /* declared but not installed here — keep looking */
    }
  }
  return null;
}

async function identities() {
  const out = { protocolLine: line, capability: {}, placements: {} };

  const discovery = resolveFrom("@integraledger/lcp-discovery");
  if (!discovery)
    throw new Error("no package resolves @integraledger/lcp-discovery");
  const d = await import(discovery);
  for (const key of Object.keys(d).sort()) {
    if (/CAPABILITY_NAME|WELL_KNOWN_PATH/.test(key))
      out.capability[key] = d[key];
  }

  const placements = resolveFrom("@integraledger/lcp-placements");
  if (!placements)
    throw new Error("no package resolves @integraledger/lcp-placements");
  const { PLACEMENTS } = await import(placements);
  for (const protocol of Object.keys(PLACEMENTS).sort()) {
    const entry = PLACEMENTS[protocol];
    const m =
      entry.kind === "namespaced"
        ? entry.build(SEAL_NAMESPACE).manifest
        : entry.adapter?.manifest;
    if (!m) {
      throw new Error(
        `placement "${protocol}" (kind=${entry.kind}) yielded no manifest — the seal would silently omit it`,
      );
    }
    out.placements[protocol] = {
      field: m.field,
      encoding: m.encoding,
      tier: m.tier,
    };
  }
  if (Object.keys(out.placements).length !== Object.keys(PLACEMENTS).length) {
    throw new Error("sealed fewer placements than the registry declares");
  }
  return out;
}

if (line) {
  const actual = await identities();

  if (WRITE) {
    writeFileSync(SEAL, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(
      `sealed ${Object.keys(actual.placements).length} placements at protocol ${line}`,
    );
    process.exit(0);
  }

  if (!existsSync(SEAL)) {
    fail.push(
      "no seal at scripts/wire-identities.seal.json — run `pnpm seal:wire`",
    );
  } else {
    const a = JSON.stringify(actual, null, 2);
    const b = JSON.stringify(JSON.parse(readFileSync(SEAL, "utf8")), null, 2);
    if (a !== b) {
      const al = a.split("\n");
      const bl = b.split("\n");
      const delta = [];
      for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i]) {
          if (bl[i] !== undefined) delta.push(`    - sealed  ${bl[i].trim()}`);
          if (al[i] !== undefined) delta.push(`    + actual  ${al[i].trim()}`);
        }
      }
      fail.push(
        "the wire identities changed. Every value here is one a counterparty must already know to\n" +
          "  interoperate with this guard, so this is a change to what a seller must write — not a refactor:\n" +
          delta.slice(0, 40).join("\n") +
          "\n\n  If the change is intended, reseal with `pnpm seal:wire` and say so in the changeset.",
      );
    }
  }
} else if (WRITE) {
  fail.push(
    "cannot seal while the tree exercises more than one protocol line — fix that first",
  );
}

if (fail.length) {
  console.error("\n✕ wire-identity check failed\n");
  for (const f of fail) console.error(`  • ${f}\n`);
  process.exit(1);
}

console.log(
  `✓ one exercised protocol line (${line}), every peer range satisfied, wire identities match the seal`,
);

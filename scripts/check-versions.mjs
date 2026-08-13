#!/usr/bin/env node
/**
 * Refuse a publishable package sitting at `0.0.0`. Runs FIRST in `pnpm verify`, before the build, because
 * it costs milliseconds and the thing it prevents is not recoverable.
 *
 * THIS IS NOT HYGIENE. `changeset publish` ships any package whose `package.json` version is absent from
 * the registry. A package scaffolded at the changesets "never released" sentinel therefore publishes
 * `0.0.0` as a REAL, installable version the first time a release runs — before `changeset version` has
 * ever run, and without anyone deciding to release it.
 *
 * This is not hypothetical: a release wave elsewhere published a stray `0.0.0` beside the real version for
 * every package that had been scaffolded at the sentinel, and for none that had not.
 *
 * Cleaning up afterwards is worse than it sounds: deleting a package's SOLE registry version deletes the
 * package and BURNS THE NAME, so a stray cannot be removed until a real version sits beside it, and the git
 * tag it created has to be swept separately because deleting a registry version does not touch its tag.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const SENTINEL = "0.0.0";

const offenders = [];
for (const dir of readdirSync(`${root}/packages`)) {
  const manifest = `${root}/packages/${dir}/package.json`;
  // A stray file in packages/ must not crash the gate that every verify now depends on.
  if (!statSync(`${root}/packages/${dir}`).isDirectory()) continue;
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  // Private packages never reach a registry, so the sentinel is harmless there and stays allowed.
  if (pkg.private === true) continue;
  if (typeof pkg.version !== "string" || pkg.version.length === 0)
    offenders.push([dir, "declares no version at all"]);
  else if (pkg.version === SENTINEL)
    offenders.push([dir, `is publishable and sits at ${SENTINEL}`]);
}

if (offenders.length > 0) {
  const lines = offenders.map(([dir, why]) => `  - packages/${dir} ${why}`);
  console.error(
    `\nRefusing to verify: ${offenders.length} publishable package(s) would publish a version nobody chose.\n\n${lines.join("\n")}\n\n` +
      `\`changeset publish\` ships any version absent from the registry, so ${SENTINEL} would go out as a\n` +
      `real, installable version before \`changeset version\` has ever run. Scaffold a new package at 0.1.0\n` +
      `and let changesets take it from there.\n\n` +
      `This is not reversible in place: deleting a package's only registry version burns the name.\n`,
  );
  process.exit(1);
}

console.log(
  "check:versions — no publishable package is at the changesets sentinel.",
);

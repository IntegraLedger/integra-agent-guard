/**
 * Approve staged package versions — the human half of the staged-publishing gate.
 *
 * The release workflow only STAGES. Nothing is installable until a maintainer approves it with a 2FA
 * challenge the registry enforces against the exact bytes, which is what makes the gate survive a
 * compromised workflow. This script is the ergonomics of that approval, not the authority for it: every
 * approval below is still an `npm stage approve` that npm accepts or refuses on its own terms.
 *
 * It exists because a coordinated release is one approval per package — `npm stage approve` takes one
 * stage id, and
 * batch approval is undocumented. Hand-typed commands are how a step gets skipped.
 *
 * It also OWNS TAGGING, and that placement is the point. `changeset publish` used to tag in the runner at
 * publish time; staging is not publishing, so a tag written then could point at a version later rejected.
 * Tags are written here, after the version-specific registry endpoint has CONFIRMED the version is live —
 * not after `npm stage approve` merely exits zero — and only the tags this run wrote are pushed.
 *
 *   node scripts/approve-staged.mjs --otp 123456          approve every staged version, then tag
 *   node scripts/approve-staged.mjs --otp 123456 --dry-run  show what would be approved
 *   node scripts/approve-staged.mjs --list                  just list what is staged
 *
 * A TOTP code lives about 30 seconds. npm accepts one per approval, so a long run may need a second code:
 * on an OTP rejection this stops rather than continuing, and re-running skips what already went live.
 */
import { execFileSync } from "node:child_process";
import { argv, exit } from "node:process";

const arg = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return v;
};
const has = (flag) => argv.includes(flag);

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** What npm currently holds staged for this account. */
function staged() {
  let out;
  try {
    out = run("npm", ["stage", "list", "--json"]);
  } catch (cause) {
    const msg = String(cause.stderr ?? cause.message);
    // The two failures an operator actually hits, told apart, because the fix differs and a stack trace
    // in the middle of a release tells them neither.
    if (/E401|Unable to authenticate|need auth/i.test(msg))
      throw new Error(
        "not authenticated to npm. Approval is a proof-of-presence action tied to your account — run\n" +
          "`npm login` first. CI cannot do this step and is not supposed to be able to.",
      );
    if (
      /Unknown command|not a valid command|stage/i.test(msg) &&
      /Unknown|Usage/i.test(msg)
    )
      throw new Error(
        `this npm CLI has no \`stage\` command (npm ${run("npm", ["--version"]).trim()}). Staged publishing\n` +
          "needs npm 11.15.0 or newer.",
      );
    throw new Error(`\`npm stage list\` failed:\n${msg.trim()}`);
  }
  const parsed = JSON.parse(out);
  // npm's shape has moved between minors; accept an array or a wrapped list rather than guessing one.
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed.staged ?? parsed.results ?? []);
  return rows.map((r) => ({
    id: r.id ?? r.stageId ?? r.stage_id,
    name: r.name ?? r.package,
    version: r.version,
  }));
}

let rows;
try {
  rows = staged();
} catch (e) {
  console.error(`\n${e.message}`);
  exit(1);
}
if (rows.length === 0) {
  console.log("nothing staged.");
  exit(0);
}

console.log(`${rows.length} staged version(s):`);
for (const r of rows) console.log(`  ${r.name}@${r.version}  (${r.id})`);

if (has("--list")) exit(0);
if (has("--dry-run")) {
  console.log("\n--dry-run: nothing approved.");
  exit(0);
}

const otp = arg("--otp");
if (otp === undefined) {
  // No prompting, and no fallback to an unauthenticated attempt: an approval that silently did not happen
  // is the one outcome this script must never produce.
  console.error(
    "\n--otp <code> is required. Approval is a proof-of-presence action; npm will not accept an OIDC\n" +
      "token for it, and this script will not pretend to have approved something it did not.",
  );
  exit(1);
}

const approved = [];
for (const r of rows) {
  process.stdout.write(`approving ${r.name}@${r.version} … `);
  try {
    run("npm", ["stage", "approve", r.id, "--otp", otp]);
    console.log("live");
    approved.push(r);
  } catch (cause) {
    const msg = String(cause.stderr ?? cause.message);
    console.log("FAILED");
    // An expired or reused OTP is the expected failure on a long run, and continuing would burn the
    // remaining ids against a code npm has already rejected. Stop, report, let the operator re-run.
    if (/otp|one-time|EOTP|401|403/i.test(msg)) {
      console.error(
        `\nnpm rejected the OTP. ${approved.length} approved before this point and are live;\n` +
          "re-run with a fresh code to continue — what is already live will not appear as staged again.",
      );
    } else {
      console.error(`\n${msg.trim()}`);
    }
    break;
  }
}

if (approved.length === 0) exit(1);

// CONFIRM WITH THE REGISTRY, not with an exit code. `npm stage approve` returning 0 says npm accepted the
// approval; it does not say the version is installable. This script's whole reason for owning tagging is
// that a tag must point at something that actually went live, and an exit code is the same kind of evidence
// the workflow already refuses elsewhere.
//
// The VERSION-SPECIFIC endpoint, never `npm view` or the packument: both serve cached documents that can
// omit a version for minutes after it is live, which is the failure that made a successful bootstrap read
// as a failed one in the sibling repository.
const live = [];
for (const r of approved) {
  const url = `https://registry.npmjs.org/${r.name}/${r.version}`;
  let ok = false;
  for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      ok = res.ok;
    } catch {
      ok = false;
    }
    // The endpoint is authoritative but not instantaneous; a short backoff distinguishes "not yet visible"
    // from "not there", and refusing to tag is the safe end of that distinction either way.
    if (!ok && attempt < 5)
      await new Promise((r2) => setTimeout(r2, attempt * 2000));
  }
  if (ok) live.push(r);
  else
    console.error(
      `::warning::${r.name}@${r.version} was approved but is not answering at ${url} — NOT tagging it. ` +
        "Re-run once it is visible; a tag pointing at a version nobody can install is worse than no tag.",
    );
}
if (live.length === 0) {
  console.error("\nnothing confirmed live at the registry — no tags written.");
  exit(1);
}

// Tag ONLY what the registry confirmed. Annotated, matching the tag shape this repo already used.
console.log(`\ntagging ${live.length} confirmed-live version(s)…`);
const written = [];
for (const r of live) {
  const tag = `${r.name}@${r.version}`;
  try {
    run("git", ["tag", "-a", tag, "-m", tag]);
    written.push(tag);
  } catch (cause) {
    if (!/already exists/i.test(String(cause.stderr ?? cause.message)))
      throw cause;
    // Already tagged by an earlier run — still ours to push, in case that run stopped before pushing.
    written.push(tag);
  }
}
// W-2b: push exactly the tags this run confirmed, never `--tags`. `--tags` pushes every local tag in the
// working copy, including ones an operator created while testing and never meant to publish. A release
// should move only what it decided to move.
run("git", ["push", "origin", ...written]);
// COUNTS CONFIRMATIONS, not approvals. `live` is shorter than `approved` exactly when the registry did not
// answer for something npm accepted — which is the case this script now detects — so reporting `approved`
// here would print "N of N live and tagged" directly beneath a warning that one of them was not tagged.
// That is the same over-claim the confirmation loop above exists to remove.
console.log(
  `pushed. ${live.length} of ${rows.length} staged version(s) are confirmed live and tagged.`,
);
if (live.length !== approved.length)
  console.log(
    `${approved.length - live.length} approved but unconfirmed — re-run once the registry answers for them.`,
  );
if (approved.length !== rows.length)
  console.log(
    `${rows.length - approved.length} still staged — re-run with a fresh --otp.`,
  );

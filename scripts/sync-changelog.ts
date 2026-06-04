#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Sync CHANGELOG.md with `Release vX.Y.Z` commits.
 *
 * This repo's convention: every release is a commit whose subject is
 * `Release vX.Y.Z` and whose body *is* that version's changelog. This
 * script finds release commits newer than the top of CHANGELOG.md that
 * are missing a section, and inserts one for each — using the commit
 * body when present, or falling back to the list of commits that landed
 * in that version.
 *
 * Runs on Node 23.6+ (native TypeScript type-stripping), no deps:
 *
 *   node scripts/sync-changelog.ts --check     # exit 1 if a release is missing (CI/hook)
 *   node scripts/sync-changelog.ts --dry-run   # print what would be inserted
 *   node scripts/sync-changelog.ts             # write the missing sections in place
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Release {
  version: string;
  hash: string;
  date: string;
  prev: string | null; // boundary commit of the previous release
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = join(HERE, "..", "CHANGELOG.md");
const RELEASE_RE = /^Release v(\d+\.\d+\.\d+)/;
const HEADER_RE = /^## \[(\d+\.\d+\.\d+)\]/;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function versionKey(v: string): number[] {
  return v.split(".").map((p) => Number(p));
}

/** Lexicographic compare of version tuples: <0, 0, >0. */
function compareKey(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest-first list of release commits. */
function releaseCommits(): Release[] {
  const out = git("log", "--format=%H%x1f%cI%x1f%s", "--reverse");
  const releases: Release[] = [];
  let prevReleaseHash: string | null = null; // boundary of previous release
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [hash, isoDate, subject] = line.split("\x1f");
    const m = RELEASE_RE.exec(subject);
    if (m) {
      releases.push({
        version: m[1],
        hash,
        date: isoDate.slice(0, 10),
        prev: prevReleaseHash,
      });
      prevReleaseHash = hash;
    }
  }
  return releases.reverse();
}

function cleanBody(body: string): string {
  return body
    .split("\n")
    .filter((ln) => !ln.startsWith("Co-Authored-By:"))
    .join("\n")
    .trim();
}

/** For empty-body releases: list the commits that landed in the version. */
function fallbackBullets(rel: Release): string {
  if (!rel.prev) return "";
  const range = `${rel.prev}..${rel.hash}`;
  const subjects = git("log", "--no-merges", "--format=%s", range)
    .split("\n")
    .filter((s) => s && !RELEASE_RE.test(s));
  if (subjects.length === 0) return "";
  return "### Changed\n\n" + subjects.map((s) => `- ${s}`).join("\n");
}

function sectionFor(rel: Release): string[] {
  let body = cleanBody(git("log", "-1", "--format=%b", rel.hash));
  if (!body) body = fallbackBullets(rel);
  const text = `## [${rel.version}] — ${rel.date}\n\n${body}\n`.replace(
    /\s+$/,
    "",
  );
  return text.split("\n");
}

function main(): number {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const dryRun = argv.includes("--dry-run");

  const lines = readFileSync(CHANGELOG, "utf8").split("\n");

  const present = new Set<string>();
  for (const ln of lines) {
    const m = HEADER_RE.exec(ln);
    if (m) present.add(m[1]);
  }

  // Only consider releases NEWER than the newest version already in the
  // changelog. Older patch releases were curated out on purpose, so we
  // don't try to backfill the whole history — just keep the top in sync.
  let newest = [0];
  for (const v of present) {
    if (compareKey(versionKey(v), newest) > 0) newest = versionKey(v);
  }
  const missing = releaseCommits().filter(
    (r) => !present.has(r.version) && compareKey(versionKey(r.version), newest) > 0,
  );

  if (missing.length === 0) {
    console.log("CHANGELOG.md is up to date.");
    return 0;
  }

  const names = missing.map((r) => r.version).join(", ");
  if (check) {
    console.error(`Missing from CHANGELOG.md: ${names}`);
    return 1;
  }

  // Insert oldest-first so newer versions end up nearer the top.
  const ascending = [...missing].sort((a, b) =>
    compareKey(versionKey(a.version), versionKey(b.version)),
  );
  for (const rel of ascending) {
    const section = sectionFor(rel);
    // Place before the first existing header with a lower version, else
    // before the pre-history footer / end of file.
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = HEADER_RE.exec(lines[i]);
      if (m && compareKey(versionKey(m[1]), versionKey(rel.version)) < 0) {
        insertAt = i;
        break;
      }
    }
    lines.splice(insertAt, 0, ...section, "");
  }

  if (dryRun) {
    for (const r of missing) console.log("  " + r.version);
    console.log("--- would write CHANGELOG.md with the above sections ---");
    return 0;
  }

  writeFileSync(CHANGELOG, lines.join("\n").replace(/\s+$/, "") + "\n");
  console.log(`Inserted ${missing.length} section(s): ${names}`);
  return 0;
}

process.exit(main());

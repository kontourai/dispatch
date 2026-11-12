#!/usr/bin/env node
// Bearing peer compatibility leg: node scripts/bearing-compat.mjs <bearing-version>
//
// Installs the packed Dispatch tarball into a fresh consumer project the way an
// adopter would (npm, which refuses peer conflicts), next to the given Bearing
// version and a current Datum, which carries its own Bearing dependency. In
// that project it then:
//   1. asserts the Bearing that actually resolved is the requested version,
//      so a leg can never pass against a different copy;
//   2. typechecks a consumer of `@kontourai/dispatch/bearing` against that
//      version's declarations, with a negative check that the parameter type
//      did not degrade to `any`;
//   3. ranks a real catalog with that version and projects the result.
// Run `npm run build` first; the tarball packs `dist/`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Datum pins its own Bearing; installing it alongside reproduces the adopter's
// combination. Pinned so the leg does not drift with Datum releases.
const DATUM_VERSION = "0.8.1";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error("usage: node scripts/bearing-compat.mjs <exact-bearing-version>");
  process.exit(64);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist/src/bearing.js"))) {
  console.error("dist/src/bearing.js is missing; run `npm run build` first");
  process.exit(1);
}
const tsc = join(root, "node_modules/typescript/bin/tsc");
if (!existsSync(tsc)) {
  console.error("typescript is not installed; run `pnpm install` first");
  process.exit(1);
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const work = mkdtempSync(join(tmpdir(), "dispatch-bearing-compat-"));
try {
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], root));
  const tarball = join(packDir, packed[0].filename);

  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "bearing-compat-consumer", private: true, type: "module" }));
  // No --legacy-peer-deps or --force: a peer range that excludes this Bearing
  // version must fail here with ERESOLVE.
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact",
    tarball, `@kontourai/bearing@${version}`, `@kontourai/datum@${DATUM_VERSION}`], consumer);

  const resolved = JSON.parse(readFileSync(join(consumer, "node_modules/@kontourai/bearing/package.json"), "utf8")).version;
  if (resolved !== version) throw new Error(`requested @kontourai/bearing@${version} but ${resolved} resolved`);

  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      // Library declarations stay checked: with skipLibCheck an unresolvable
      // Bearing import in Dispatch's .d.ts would silently become `any`.
      noEmit: true, skipLibCheck: false, types: [],
    },
    files: ["check.mts"],
  }));
  writeFileSync(join(consumer, "check.mts"), `
import { compileCatalog, rankCatalog, type RankedCandidate } from "@kontourai/bearing";
import { capabilityEvidenceFromBearing } from "@kontourai/dispatch/bearing";

const model = { id: "example/model-a", revision: "r1", quantization: null };
const snapshot = compileCatalog([{
  schemaVersion: "bearing.observation/v2",
  kind: "declaration",
  model,
  execution: null,
  task: null,
  measurements: [{ key: "tools", kind: "fact", value: true }],
  outcome: null,
  usage: null,
  sourceClass: "external",
  evidence: [{ id: "model-card", kind: "model-card", uri: null, digest: null, observedAt: "2026-07-18T20:00:00.000Z" }],
  freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil: null },
  uncertainty: { level: "low", basis: ["fixture"], gaps: [] },
}], { asOf: "2026-07-18T22:00:00.000Z" });

const result = rankCatalog(snapshot, {
  schemaVersion: "bearing.rank.request/v1",
  task: { family: "software-engineering", suite: null },
  inventory: [{
    id: "runtime:model-a",
    model,
    execution: { runtime: { id: "api", version: null }, adapter: null, effectiveContextTokens: null, toolSurface: ["tools"], hardware: null, workflow: null },
  }],
  requirements: [{ measurementKey: "tools", aggregation: "fact", operator: "eq", value: true }],
  preferences: [],
});

const ranked: RankedCandidate | undefined = result.ranked[0];
if (!ranked) throw new Error("Bearing ranked no candidate: " + JSON.stringify(result.excluded));
const evidence = capabilityEvidenceFromBearing(ranked, snapshot.digest);
// Type-level only, never called: if this line compiles, the parameter type degraded to any.
// @ts-expect-error A non-candidate must be rejected.
export const typeProbe = () => capabilityEvidenceFromBearing({}, snapshot.digest);

const expected = JSON.stringify({ level: "confirmed", capabilities: ["tools"], source: "bearing:catalog:" + snapshot.digest });
if (JSON.stringify(evidence) !== expected) throw new Error("unexpected projection " + JSON.stringify(evidence));
console.log("projected " + JSON.stringify(evidence));
`);
  run(process.execPath, [tsc, "-p", "tsconfig.json"], consumer);
  // Node 22.18+ and 24 strip the type annotations; the import runs Bearing's real ranker.
  process.stdout.write(run(process.execPath, ["check.mts"], consumer));
  console.log(`bearing-compat: @kontourai/bearing@${resolved} installed beside @kontourai/datum@${DATUM_VERSION} without peer conflict, typechecked, and projected`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

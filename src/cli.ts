import { readFile } from "node:fs/promises";
import { FakeModelRuntime, ReplayModelRuntime, type InvocationReplayRecord, type ModelInvocationResult, type ModelRuntime } from "@kontourai/relay";
import { dispatch } from "./engine.js";
import type { ExecutionPlan, RuntimeRegistry } from "./types.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function usage(): never {
  throw new Error("Usage: dispatch <fixture|replay> --plan <file> (--fixtures <file>|--records <file>)");
}

function option(name: string, args: readonly string[]): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

async function readJson(path: string): Promise<unknown> {
  const data = await readFile(path);
  if (data.byteLength > MAX_INPUT_BYTES) throw new Error("Dispatch input exceeds 2 MiB");
  return JSON.parse(data.toString("utf8"));
}

function registry(entries: ReadonlyMap<string, ModelRuntime>): RuntimeRegistry {
  return { get: (id) => entries.get(id) };
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command !== "fixture" && command !== "replay") usage();
  const plan = await readJson(option("--plan", args)) as ExecutionPlan;
  let runtimes: RuntimeRegistry;
  if (command === "fixture") {
    const fixture = await readJson(option("--fixtures", args)) as { runtimes?: Record<string, ModelInvocationResult[]> };
    const entries = new Map(Object.entries(fixture.runtimes ?? {}).map(([id, results]) => [id, new FakeModelRuntime(results)]));
    runtimes = registry(entries);
  } else {
    const records = await readJson(option("--records", args)) as InvocationReplayRecord[];
    const replay = new ReplayModelRuntime(records);
    runtimes = { get: () => replay };
  }
  const outcome = await dispatch(plan, runtimes);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "dispatch.cli.result/v1", ...outcome }, null, 2)}\n`);
  if (outcome.receipt.outcome !== "succeeded") process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`dispatch: ${error instanceof SyntaxError ? "Invalid JSON input" : error instanceof Error ? error.message : "Command failed"}\n`);
  process.exitCode = 1;
});

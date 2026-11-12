import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Runs the published quickstart sketches as written. The only substitution is
// the Relay import: the sketch builds a credentialed Anthropic runtime, and the
// test swaps in a fake factory so the plan's routing is what gets exercised.
// The module is written next to this compiled test, inside the package, so the
// sketch's own `@kontourai/dispatch` import resolves through the package's
// self-reference to the built entrypoint.

const relayImport = 'import { createAnthropicRuntime } from "@kontourai/relay/anthropic";';
const fakeFactory = `const createAnthropicRuntime = (config) => ({
  id: "readme-fake",
  capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
  async invoke() {
    globalThis.__dispatchSnippetInvocations = (globalThis.__dispatchSnippetInvocations ?? 0) + 1;
    return { provider: "fixture", model: config.model, outputText: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0 };
  },
});`;

function sketchUnder(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `heading ${heading} not found`);
  const open = markdown.indexOf("\n```ts\n", start);
  assert.notEqual(open, -1, `no ts block under ${heading}`);
  const body = open + "\n```ts\n".length;
  const close = markdown.indexOf("\n```\n", body);
  assert.notEqual(close, -1, `unterminated ts block under ${heading}`);
  return markdown.slice(body, close + 1);
}

async function runSketch(document: string, heading: string, name: string) {
  const markdown = await readFile(fileURLToPath(new URL(`../../${document}`, import.meta.url)), "utf8");
  const sketch = sketchUnder(markdown, heading);
  assert.equal(sketch.split(relayImport).length, 2, `${document} sketch must import createAnthropicRuntime exactly once`);
  assert.match(sketch, /^import \{ dispatch \} from "@kontourai\/dispatch";$/mu);
  const source = `${sketch.replace(relayImport, fakeFactory)}\nexport { outcome };\n`;
  const file = fileURLToPath(new URL(`./.snippet-${name}-${process.pid}.mjs`, import.meta.url));
  await writeFile(file, source);
  const log = console.log;
  const globals = globalThis as { __dispatchSnippetInvocations?: number };
  globals.__dispatchSnippetInvocations = 0;
  console.log = () => {};
  try {
    const module = await import(file) as { outcome: { receipt: { outcome: string; attempts: readonly unknown[] } } };
    return { receipt: module.outcome.receipt, invocations: globals.__dispatchSnippetInvocations };
  } finally {
    console.log = log;
    await rm(file, { force: true });
  }
}

describe("documentation sketches", () => {
  it("runs the README SDK sketch to a successful dispatch", async () => {
    const { receipt, invocations } = await runSketch("README.md", "## SDK sketch", "readme");
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(receipt.attempts.length, 1);
    assert.equal(invocations, 1);
  });

  it("runs the getting-started code sketch to a successful dispatch", async () => {
    const { receipt, invocations } = await runSketch("docs/getting-started.md", "## Call Dispatch from code", "getting-started");
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(receipt.attempts.length, 1);
    assert.equal(invocations, 1);
  });
});

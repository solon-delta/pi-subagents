import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverAndLoadExtensions,
  type ExtensionActions,
  type ExtensionContextActions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

const extensionPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

/** What pi accepts as message content, taken from the action it belongs to. */
type Content = Parameters<ExtensionActions["sendMessage"]>[0]["content"];

interface SentMessage {
  content: Content;
  options: { triggerTurn?: boolean; deliverAs?: string };
}

/** The text the model sees. An image part carries no text and drops out. */
function text(content: Content): string {
  if (!Array.isArray(content)) return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function unbound(): never {
  throw new Error("the extension called an action that this test does not bind");
}

/**
 * The extension under the real pi runtime. Nothing here stubs the extension
 * API: pi loads index.ts, and pi builds the context that the tool receives.
 */
async function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "ext-cwd-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "ext-session-"));

  const loaded = await discoverAndLoadExtensions([extensionPath], cwd, sessionDir);
  assert.deepEqual(loaded.errors, []);

  const sessionManager = SessionManager.create(cwd, sessionDir);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(await ModelRuntime.create()),
  );

  const sent: SentMessage[] = [];
  let deliver = (): void => {};
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });

  const actions: ExtensionActions = {
    sendMessage: (message, options) => {
      sent.push({ content: message.content, options: options ?? {} });
      deliver();
    },
    sendUserMessage: unbound,
    appendEntry: unbound,
    setSessionName: unbound,
    getSessionName: unbound,
    setLabel: unbound,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: unbound,
    refreshTools: unbound,
    getCommands: () => [],
    setModel: unbound,
    getThinkingLevel: unbound,
    setThinkingLevel: unbound,
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: unbound,
    hasPendingMessages: () => false,
    shutdown: unbound,
    getContextUsage: () => undefined,
    compact: unbound,
    getSystemPrompt: () => "",
  };
  runner.bindCore(actions, contextActions);

  chmodSync(fakePi, 0o755);
  process.env.PI_SUBAGENTS_PI_BIN = fakePi;

  return { runner, sessionManager, sent, delivered };
}

function subagentTool(runner: ExtensionRunner) {
  const tool = runner.getToolDefinition("subagent");
  assert.ok(tool !== undefined, "the extension registers no subagent tool");
  return tool;
}

/** Call the registered tool the way pi calls it, and return the run id. */
async function callSubagent(runner: ExtensionRunner, task: string): Promise<string> {
  const result = await subagentTool(runner).execute(
    "call-1",
    { agent: "explorer", task },
    AbortSignal.timeout(30_000),
    () => {},
    runner.createContext(),
  );

  const started = /run ([0-9a-f]{8})\b/.exec(text(result.content));
  assert.ok(started !== null, `the tool reports no run id: ${text(result.content)}`);
  return started[1];
}

test("pi loads the extension and registers the subagent tool", async () => {
  const { runner } = await harness();

  assert.deepEqual(
    runner.getAllRegisteredTools().map((tool) => tool.definition.name),
    ["subagent"],
  );
});

test("the tool takes an agent name and a task text", async () => {
  const { runner } = await harness();
  const schema = subagentTool(runner).parameters;

  assert.ok(Check(schema, { agent: "explorer", task: "Find the entry point" }));
  assert.ok(!Check(schema, { agent: "explorer" }), "the task is optional");
  assert.ok(!Check(schema, { task: "Find the entry point" }), "the agent name is optional");
});

test("the tool returns a run id before the child finishes", async () => {
  const { runner, sent } = await harness();

  await callSubagent(runner, "Find the entry point");

  assert.equal(sent.length, 0, "the answer must not arrive before the tool returns");
});

test("the run directory sits under the session directory of the session manager", async () => {
  const { runner, sessionManager } = await harness();

  const runId = await callSubagent(runner, "Find the entry point");

  const dir = join(
    sessionManager.getSessionDir(),
    "subagents",
    sessionManager.getSessionId(),
    runId,
  );
  assert.ok(existsSync(join(dir, "transcript.jsonl")), `no transcript under ${dir}`);
  assert.ok(existsSync(join(dir, "run.json")), `no metadata record under ${dir}`);
});

test("the answer arrives as a steer message that names the agent and the run", async () => {
  const { runner, sent, delivered } = await harness();

  const runId = await callSubagent(runner, "Find the entry point");
  await delivered;

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(text(sent[0].content), /explorer/);
  assert.match(text(sent[0].content), new RegExp(runId));
  assert.match(text(sent[0].content), /completed/);
});

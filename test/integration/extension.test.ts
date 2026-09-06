import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CONFIG_DIR_NAME,
  discoverAndLoadExtensions,
  type ExtensionActions,
  type ExtensionContextActions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
 * The live tool list that pi reports to an extension. A built-in tool of pi
 * carries an angle bracket path, and the two tools of this package carry the
 * file that pi loaded them from.
 */
function liveTools(): ToolInfo[] {
  const tool = (name: string, path: string, source: string): ToolInfo => ({
    name,
    description: name,
    parameters: Type.Object({}),
    promptGuidelines: undefined,
    sourceInfo: { path, source, scope: "user", origin: "top-level" },
  });

  return [
    ...["read", "grep", "find", "ls"].map((name) => tool(name, `<builtin:${name}>`, "builtin")),
    tool("subagent", extensionPath, "extension:index"),
    tool("subagent_stop", extensionPath, "extension:index"),
  ];
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
    getAllTools: liveTools,
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

  /** Where the extension keeps the state of every run of this session. */
  const runsDir = join(sessionManager.getSessionDir(), "subagents", sessionManager.getSessionId());
  /** Where the extension keeps the state of one run. */
  const runDir = (runId: string): string => join(runsDir, runId);

  return { runner, sent, delivered, cwd, runDir, runsDir };
}

function subagentTool(runner: ExtensionRunner) {
  const tool = runner.getToolDefinition("subagent");
  assert.ok(tool !== undefined, "the extension registers no subagent tool");
  return tool;
}

interface ToolAnswer {
  runId: string;
  text: string;
}

/** Call the registered tool the way pi calls it, and read its answer. */
async function callSubagent(runner: ExtensionRunner, task: string): Promise<ToolAnswer> {
  const result = await subagentTool(runner).execute(
    "call-1",
    { agent: "explorer", task },
    AbortSignal.timeout(30_000),
    () => {},
    runner.createContext(),
  );

  const answer = text(result.content);
  const started = /run ([0-9a-f]{8})\b/.exec(answer);
  assert.ok(started !== null, `the tool reports no run id: ${answer}`);
  return { runId: started[1], text: answer };
}

test("pi loads the extension and registers both subagent tools", async () => {
  const { runner } = await harness();

  assert.deepEqual(
    runner.getAllRegisteredTools().map((tool) => tool.definition.name),
    ["subagent", "subagent_stop"],
  );
});

test("the extension registers the stop command", async () => {
  const { runner } = await harness();

  assert.ok(runner.getCommand("subagent-stop") !== undefined, "no subagent-stop command");
});

test("the stop tool reports an unknown run id", async () => {
  const { runner } = await harness();
  const tool = runner.getToolDefinition("subagent_stop");
  assert.ok(tool !== undefined, "the extension registers no subagent_stop tool");

  const result = await tool.execute(
    "call-1",
    { runId: "deadbeef" },
    undefined,
    () => {},
    runner.createContext(),
  );

  assert.match(text(result.content), /No subagent run "deadbeef"/);
});

test("the tool takes an agent name and a task text", async () => {
  const { runner } = await harness();
  const schema = subagentTool(runner).parameters;

  assert.ok(Check(schema, { agent: "explorer", task: "Find the entry point" }));
  assert.ok(!Check(schema, { agent: "explorer" }), "the task is optional");
  assert.ok(!Check(schema, { task: "Find the entry point" }), "the agent name is optional");
});

test("every turn carries the agents of the session in the system prompt", async () => {
  const { runner, cwd } = await harness();
  mkdirSync(join(cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
  writeFileSync(
    join(cwd, CONFIG_DIR_NAME, "agents", "reviewer.md"),
    "---\ndescription: Reviews a diff.\ntools: [read, grep]\n---\n\nYou review code.\n",
  );

  const result = await runner.emitBeforeAgentStart("Split this task", undefined, "Base prompt.", {
    cwd,
  });

  const prompt = result?.systemPrompt;
  assert.ok(prompt !== undefined, "the turn got no system prompt from the extension");
  assert.ok(prompt.startsWith("Base prompt."));
  assert.match(prompt, /<available_agents>/);
  assert.match(prompt, /<name>reviewer<\/name>/);
  assert.match(prompt, /<name>explorer<\/name>/);
});

test("an agent file with an unknown tool name fails the tool call", async () => {
  const { runner, sent, cwd, runsDir } = await harness();
  mkdirSync(join(cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
  writeFileSync(
    join(cwd, CONFIG_DIR_NAME, "agents", "typo-tools.md"),
    "---\ndescription: An agent with a typo\ntools: [read, webserch]\n---\n\nYou read files.\n",
  );

  await assert.rejects(
    subagentTool(runner).execute(
      "call-1",
      { agent: "typo-tools", task: "Find the entry point" },
      undefined,
      () => {},
      runner.createContext(),
    ),
    (error: Error) => {
      assert.match(error.message, /webserch/);
      // The name comes from the agent file, not from a literal in the test.
      assert.match(error.message, /typo-tools/);
      return true;
    },
  );

  assert.ok(!existsSync(runsDir), "the failed launch took disk");
  assert.equal(sent.length, 0, "the failed launch reached the conversation");
});

test("the tool returns a run id before the child finishes", async () => {
  const { runner, sent } = await harness();

  await callSubagent(runner, "Find the entry point");

  assert.equal(sent.length, 0, "the answer must not arrive before the tool returns");
});

test("the run directory sits under the session directory of the session manager", async () => {
  const { runner, runDir } = await harness();

  const { runId } = await callSubagent(runner, "Find the entry point");

  const dir = runDir(runId);
  assert.ok(existsSync(join(dir, "transcript.jsonl")), `no transcript under ${dir}`);
  assert.ok(existsSync(join(dir, "run.json")), `no metadata record under ${dir}`);
});

test("a spawn above the limit is queued and starts after the parent turn ends", async () => {
  const { runner, sent, cwd, runDir } = await harness();
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"), '{"maxConcurrency": 1}');
  process.env.FAKE_PI_HOLD_MS = "150";

  const status = (runId: string): string =>
    JSON.parse(readFileSync(join(runDir(runId), "run.json"), "utf8")).status;

  try {
    const first = await callSubagent(runner, "Find the entry point");
    const second = await callSubagent(runner, "Find the tests");

    assert.match(first.text, /^Started subagent/);
    assert.match(second.text, /^Queued subagent/);
    assert.equal(status(second.runId), "queued");
    assert.equal(sent.length, 0, "no answer arrives while the tool calls run");

    // The parent turn ends here. pi fires this event when a run has settled
    // and nothing else in the turn will follow. The queue must still drain.
    await runner.emit({ type: "agent_settled" });

    while (sent.length < 2) await setTimeout(20);
    assert.equal(status(second.runId), "completed");
  } finally {
    delete process.env.FAKE_PI_HOLD_MS;
  }
});

test("the answer arrives as a steer message that names the agent and the run", async () => {
  const { runner, sent, delivered } = await harness();

  const { runId } = await callSubagent(runner, "Find the entry point");
  await delivered;

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(text(sent[0].content), /explorer/);
  assert.match(text(sent[0].content), new RegExp(runId));
  assert.match(text(sent[0].content), /completed/);
});

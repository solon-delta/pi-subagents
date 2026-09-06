import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agent-file.ts";
import { type ChildNesting, childNesting, type ToolSource } from "../../src/nesting.ts";
import { createRun, type Run, type RunOutcome } from "../../src/run.ts";

interface AgentLaunch {
  agent: AgentDefinition;
  nesting: ChildNesting;
  skillsBlock: string;
}

/** The extension file of this package, which backs the two subagent tools. */
const self = fileURLToPath(new URL("../../index.ts", import.meta.url));

/** The live tool list of a session that loaded this extension. */
const SESSION_TOOLS: ToolSource[] = [
  { name: "read", path: "<builtin:read>" },
  { name: "grep", path: "<builtin:grep>" },
  { name: "subagent", path: self },
  { name: "subagent_stop", path: self },
];

/** A root launch of one agent: depth one, every tool of the file. */
function rootLaunch(agent: AgentDefinition): AgentLaunch {
  return {
    agent,
    nesting: childNesting({ depth: 0, limit: 3 }, agent, SESSION_TOOLS),
    skillsBlock: "",
  };
}

/** Start a run and wait for its end. */
function runStarted(run: Run): Promise<RunOutcome> {
  run.start();
  return run.done;
}

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

const agent: AgentDefinition = {
  name: "reviewer",
  description: "Reviews a diff",
  tools: ["read", "grep"],
  skills: [],
  model: "anthropic/claude-sonnet-5",
  maxDepth: undefined,
  systemPromptMode: "replace",
  systemPrompt: "You review code.",
  file: "/agents/reviewer.md",
};

function environment(runsDir: string, exit: string): NodeJS.ProcessEnv {
  chmodSync(fakePi, 0o755);
  return {
    ...process.env,
    PI_SUBAGENTS_PI_BIN: fakePi,
    FAKE_PI_ARGV_OUT: join(runsDir, "argv.json"),
    FAKE_PI_STDIN_OUT: join(runsDir, "stdin.txt"),
    FAKE_PI_EXIT: exit,
  };
}

test("a run drives the fake child and reports its answer", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch(agent),
    task: "Review the diff",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });

  assert.match(run.id, /^[0-9a-f]{8}$/);
  const outcome = await runStarted(run);

  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.deepEqual(argv, [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "read,grep",
    "--model",
    "anthropic/claude-sonnet-5",
    "--system-prompt",
    "You review code.",
  ]);
  assert.equal(readFileSync(join(runsDir, "stdin.txt"), "utf8"), "Review the diff");

  const transcript = readFileSync(join(run.dir, "transcript.jsonl"), "utf8").trim().split("\n");
  assert.equal(transcript.length, 4);
  assert.equal(JSON.parse(transcript[0]).type, "session");

  const record = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8"));
  assert.equal(record.agent, "reviewer");
  assert.equal(record.model, "anthropic/claude-sonnet-5");
  assert.equal(record.status, "completed");
  assert.ok(record.startedAt.length > 0);
  assert.ok(record.endedAt.length > 0);

  assert.equal(outcome.record.status, "completed");
  assert.match(outcome.message, /reviewer/);
  assert.match(outcome.message, new RegExp(run.id));
  assert.match(outcome.message, /The task is done\./);
});

test("a task that starts with @ reaches the child unchanged", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch(agent),
    task: "@types migration",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });
  await runStarted(run);

  assert.equal(readFileSync(join(runsDir, "stdin.txt"), "utf8"), "@types migration");
  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.ok(!argv.some((arg) => arg.includes("@types")));
});

test("an append agent without tools gets the append flag and --no-tools", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch({
      ...agent,
      tools: [],
      model: undefined,
      systemPromptMode: "append",
      systemPrompt: "",
    }),
    task: "task",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });
  await runStarted(run);

  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.deepEqual(argv, [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-tools",
    "--append-system-prompt",
    "",
  ]);
});

test("a tool name of this extension puts the extension file on the command line", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch({ ...agent, tools: ["read", "subagent", "subagent_stop"], model: undefined }),
    task: "Split the work",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });
  await runStarted(run);

  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.deepEqual(argv, [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "read,subagent,subagent_stop",
    "--extension",
    self,
    "--system-prompt",
    "You review code.",
  ]);
});

test("the skill block goes to the child after the body of the agent file", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch({ ...agent, model: undefined }),
    skillsBlock: "\n\n<available_skills>review</available_skills>",
    task: "Review the diff",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });
  await runStarted(run);

  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.ok(argv.includes("--no-skills"));
  assert.equal(
    argv[argv.indexOf("--system-prompt") + 1],
    "You review code.\n\n<available_skills>review</available_skills>",
  );
});

test("a non-zero exit fails the run and keeps the transcript", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch({ ...agent, model: undefined }),
    task: "Review the diff",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "3"),
    timeoutMs: 0,
  });
  const outcome = await runStarted(run);

  assert.equal(outcome.record.status, "failed");
  assert.equal(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).model, null);
  assert.match(outcome.message, /failed/);
  assert.ok(readFileSync(join(run.dir, "transcript.jsonl"), "utf8").length > 0);
  assert.equal(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).status, "failed");
});

test("a missing executable fails the run", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch(agent),
    task: "task",
    cwd: runsDir,
    runsDir,
    env: { ...process.env, PI_SUBAGENTS_PI_BIN: join(runsDir, "no-such-pi") },
    timeoutMs: 0,
  });
  const outcome = await runStarted(run);

  assert.equal(outcome.record.status, "failed");
  assert.match(outcome.message, /did not start/);

  // The failed spawn emits "error" and then "close", so both handlers reach the
  // finish function. Only the first one may finish the run. Both calls stamp
  // the same millisecond, so the record alone cannot show a second call. The
  // deleted file can: a second call writes it again.
  const delivered = { ...outcome.record };
  unlinkSync(join(run.dir, "run.json"));
  await setTimeout(50);

  assert.ok(!existsSync(join(run.dir, "run.json")), "the run was finished twice");
  assert.deepEqual(outcome.record, delivered);
});

test("a stopped child gets SIGTERM, so it can clean up below itself", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const signalFile = join(runsDir, "signal.txt");

  const run = createRun({
    ...rootLaunch(agent),
    task: "task",
    cwd: runsDir,
    runsDir,
    env: {
      ...environment(runsDir, "0"),
      FAKE_PI_HANG: "1",
      FAKE_PI_SIGNAL_OUT: signalFile,
    },
    timeoutMs: 0,
  });
  run.start();

  // The stop must come after the child has its handler, or the default action
  // of SIGTERM would end the child and the test would prove nothing.
  while (!existsSync(signalFile)) await setTimeout(10);
  run.stop("The run was stopped before it finished.");
  const outcome = await run.done;

  assert.equal(outcome.record.status, "stopped");
  assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM");
});

test("a child that ignores SIGTERM takes SIGKILL after the grace time", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const signalFile = join(runsDir, "signal.txt");

  const run = createRun({
    ...rootLaunch(agent),
    task: "task",
    cwd: runsDir,
    runsDir,
    env: {
      ...environment(runsDir, "0"),
      FAKE_PI_HANG: "1",
      FAKE_PI_SIGNAL_OUT: signalFile,
      FAKE_PI_IGNORE_SIGTERM: "1",
    },
    // The run has a limit too, so the escalation must replace that timer.
    timeoutMs: 600_000,
  });
  run.start();

  while (!existsSync(signalFile)) await setTimeout(10);
  const started = Date.now();
  run.stop("The run was stopped before it finished.");
  // The child hangs for ten minutes and answers no signal, so only the SIGKILL
  // of the escalation lets this promise resolve.
  const outcome = await run.done;

  assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM");
  assert.ok(Date.now() - started >= 2_500, "the child got its grace time");
  assert.equal(outcome.record.status, "stopped");
});

test("a run that is stopped before it starts ends without a child", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const run = createRun({
    ...rootLaunch(agent),
    task: "task",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
    timeoutMs: 0,
  });

  assert.equal(run.status, "queued");
  run.stop("The run was stopped before it finished.");
  assert.equal(run.status, "stopped");

  // A later start does nothing, so the child never writes its argv file.
  run.start();
  const outcome = await run.done;

  assert.equal(outcome.record.status, "stopped");
  assert.equal(outcome.record.startedAt, undefined);
  assert.match(outcome.message, /stopped before it finished/);
  assert.equal(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).status, "stopped");
  assert.ok(!existsSync(join(runsDir, "argv.json")), "no child ran");
});

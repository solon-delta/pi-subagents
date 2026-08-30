import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agent-file.ts";
import { startRun } from "../../src/run.ts";

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

const agent: AgentDefinition = {
  name: "reviewer",
  description: "Reviews a diff",
  tools: ["read", "grep"],
  model: "anthropic/claude-sonnet-5",
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

  const started = startRun({
    agent,
    task: "Review the diff",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
  });

  assert.match(started.id, /^[0-9a-f]{8}$/);
  const outcome = await started.finished;

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

  const transcript = readFileSync(join(started.dir, "transcript.jsonl"), "utf8").trim().split("\n");
  assert.equal(transcript.length, 4);
  assert.equal(JSON.parse(transcript[0]).type, "session");

  const record = JSON.parse(readFileSync(join(started.dir, "run.json"), "utf8"));
  assert.equal(record.agent, "reviewer");
  assert.equal(record.model, "anthropic/claude-sonnet-5");
  assert.equal(record.status, "completed");
  assert.ok(record.startedAt.length > 0);
  assert.ok(record.endedAt.length > 0);

  assert.equal(outcome.record.status, "completed");
  assert.match(outcome.message, /reviewer/);
  assert.match(outcome.message, new RegExp(started.id));
  assert.match(outcome.message, /The task is done\./);
});

test("a task that starts with @ reaches the child unchanged", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const started = startRun({
    agent,
    task: "@types migration",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "0"),
  });
  await started.finished;

  assert.equal(readFileSync(join(runsDir, "stdin.txt"), "utf8"), "@types migration");
  const argv: string[] = JSON.parse(readFileSync(join(runsDir, "argv.json"), "utf8"));
  assert.ok(!argv.some((arg) => arg.includes("@types")));
});

test("a non-zero exit fails the run and keeps the transcript", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const started = startRun({
    agent: { ...agent, model: undefined },
    task: "Review the diff",
    cwd: runsDir,
    runsDir,
    env: environment(runsDir, "3"),
  });
  const outcome = await started.finished;

  assert.equal(outcome.record.status, "failed");
  assert.equal(JSON.parse(readFileSync(join(started.dir, "run.json"), "utf8")).model, null);
  assert.match(outcome.message, /failed/);
  assert.ok(readFileSync(join(started.dir, "transcript.jsonl"), "utf8").length > 0);
  assert.equal(JSON.parse(readFileSync(join(started.dir, "run.json"), "utf8")).status, "failed");
});

test("a missing executable fails the run", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));

  const started = startRun({
    agent,
    task: "task",
    cwd: runsDir,
    runsDir,
    env: { ...process.env, PI_SUBAGENTS_PI_BIN: join(runsDir, "no-such-pi") },
  });
  const outcome = await started.finished;

  assert.equal(outcome.record.status, "failed");
  assert.match(outcome.message, /did not start/);
});

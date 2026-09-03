import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agent-file.ts";
import { childNesting } from "../../src/nesting.ts";
import { createRunQueue } from "../../src/queue.ts";
import { createRun, type Run, type RunOutcome } from "../../src/run.ts";

/** Start a run and wait for its end. */
function runStarted(run: Run): Promise<RunOutcome> {
  run.start();
  return run.done;
}

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

const agent: AgentDefinition = {
  name: "explorer",
  description: "Explores a codebase",
  tools: [],
  skills: [],
  model: undefined,
  maxDepth: undefined,
  systemPromptMode: "replace",
  systemPrompt: "You explore.",
  file: "/agents/explorer.md",
};

/** The highest number of children that the log shows at the same time. */
function peak(lines: string[]): number {
  let running = 0;
  let highest = 0;
  for (const line of lines) {
    running += line === "start" ? 1 : -1;
    highest = Math.max(highest, running);
  }
  return highest;
}

test("no more children run together than the limit allows", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "queue-"));
  const log = join(runsDir, "log.txt");
  writeFileSync(log, "");
  chmodSync(fakePi, 0o755);

  const queue = createRunQueue(2);
  const finished: Promise<void>[] = [];
  const queued: string[] = [];

  for (let index = 0; index < 6; index += 1) {
    const run = createRun({
      agent,
      nesting: childNesting({ depth: 0, limit: 3, ceiling: undefined }, agent),
      skillsBlock: "",
      task: `task ${index}`,
      cwd: runsDir,
      runsDir,
      env: { ...process.env, PI_SUBAGENTS_PI_BIN: fakePi, FAKE_PI_LOG: log, FAKE_PI_HOLD_MS: "80" },
      timeoutMs: 0,
    });
    finished.push(
      new Promise<void>((done) => {
        queue.add(() => runStarted(run).then(() => done()));
      }),
    );

    // The record on disk is the only place a waiting run is visible.
    const status = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).status;
    assert.equal(status, index < 2 ? "running" : "queued");
    if (status === "queued") queued.push(run.id);
  }

  assert.deepEqual(queued.length, 4, "four of the six runs wait");
  await Promise.all(finished);

  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 12, "every run starts and ends once");
  assert.equal(peak(lines), 2);
});

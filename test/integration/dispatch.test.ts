import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createDispatcher, type Host } from "../../src/dispatch.ts";
import type { RunRecord } from "../../src/transcript.ts";

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

interface Notice {
  message: string;
  level: string;
}

interface Fake {
  host: Host;
  /** What the host was told, in arrival order. */
  notices: Notice[];
  results: RunRecord[];
  /** The current runs directory. A test moves it to model a later tool call. */
  runsDir: string;
  cwd: string;
}

/** A host that a test drives by hand. The child is the fake pi script. */
function fakeHost(userSettings: string): Fake {
  chmodSync(fakePi, 0o755);
  const agentDir = mkdtempSync(join(tmpdir(), "dispatch-agent-"));
  writeFileSync(join(agentDir, "pi-subagents.json"), userSettings);

  const notices: Notice[] = [];
  const results: RunRecord[] = [];
  let runsDir = mkdtempSync(join(tmpdir(), "dispatch-runs-"));
  let cwd = mkdtempSync(join(tmpdir(), "dispatch-cwd-"));

  const host: Host = {
    cwd: () => cwd,
    home: join(tmpdir(), "dispatch-no-home"),
    agentDir,
    projectTrusted: true,
    runsDir: () => runsDir,
    env: { ...process.env, PI_SUBAGENTS_PI_BIN: fakePi },
    notify: (message, level) => notices.push({ message, level }),
    sendResult: (_message, record) => results.push(record),
  };

  return {
    host,
    notices,
    results,
    get runsDir() {
      return runsDir;
    },
    set runsDir(next: string) {
      runsDir = next;
    },
    get cwd() {
      return cwd;
    },
    set cwd(next: string) {
      cwd = next;
    },
  };
}

test("a dispatched run starts at once and keeps its files under the runs directory", () => {
  const fake = fakeHost("{}");

  const launch = createDispatcher(fake.host).dispatch("explorer", "Find the entry point");

  assert.equal(launch.status, "running");
  assert.equal(
    launch.text,
    `Started subagent "explorer" as run ${launch.id}. Do not poll for the result.`,
  );
  assert.equal(launch.dir, join(fake.runsDir, launch.id));
  assert.ok(existsSync(join(launch.dir, "transcript.jsonl")));
  assert.ok(existsSync(join(launch.dir, "run.json")));
});

test("a run above the limit is queued and says so", () => {
  const fake = fakeHost('{"maxConcurrency": 1}');
  const dispatcher = createDispatcher(fake.host);

  dispatcher.dispatch("explorer", "Find the entry point");
  const second = dispatcher.dispatch("explorer", "Find the tests");

  assert.equal(second.status, "queued");
  assert.equal(
    second.text,
    `Queued subagent "explorer" as run ${second.id}. It starts when a slot is free. Do not poll for the result.`,
  );
});

test("the finished run reaches the host as a result", async () => {
  const fake = fakeHost("{}");

  const launch = createDispatcher(fake.host).dispatch("explorer", "Find the entry point");
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(fake.results[0].id, launch.id);
  assert.equal(fake.results[0].status, "completed");
});

test("an unusable settings file warns once and the run still starts", () => {
  const fake = fakeHost("not json");
  const dispatcher = createDispatcher(fake.host);

  dispatcher.dispatch("explorer", "Find the entry point");
  const launch = dispatcher.dispatch("explorer", "Find the tests");

  assert.equal(fake.notices.length, 1, "the settings are read once");
  assert.equal(fake.notices[0].level, "warning");
  assert.match(fake.notices[0].message, /pi-subagents\.json/);
  assert.equal(launch.status, "running");
});

test("a later launch reads the runs directory and the working directory again", () => {
  const fake = fakeHost("{}");
  const dispatcher = createDispatcher(fake.host);

  dispatcher.dispatch("explorer", "Find the entry point");

  // The host moves, as it does when a second tool call brings a new context.
  fake.runsDir = mkdtempSync(join(tmpdir(), "dispatch-runs-moved-"));
  fake.cwd = mkdtempSync(join(tmpdir(), "dispatch-cwd-moved-"));
  const second = dispatcher.dispatch("explorer", "Find the tests");

  assert.equal(second.dir, join(fake.runsDir, second.id));
  assert.ok(existsSync(join(second.dir, "run.json")));
});

test("an unknown agent name fails the dispatch", () => {
  const fake = fakeHost("{}");

  assert.throws(
    () => createDispatcher(fake.host).dispatch("typo", "Find the entry point"),
    /Unknown agent "typo"/,
  );
});

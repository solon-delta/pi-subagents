import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { createDispatcher, type Host } from "../../src/dispatch.ts";
import type { RunRecord } from "../../src/run.ts";

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
  /** The result text of each finished run, in the same order as `results`. */
  messages: string[];
  /** The current runs directory. A test moves it to model a later tool call. */
  runsDir: string;
  cwd: string;
}

/**
 * A host that a test drives by hand. The child is the fake pi script. The extra
 * environment models the values that a parent subagent passes down.
 */
function fakeHost(userSettings: string, extraEnv: NodeJS.ProcessEnv = {}): Fake {
  chmodSync(fakePi, 0o755);
  const agentDir = mkdtempSync(join(tmpdir(), "dispatch-agent-"));
  writeFileSync(join(agentDir, "pi-subagents.json"), userSettings);

  const notices: Notice[] = [];
  const results: RunRecord[] = [];
  const messages: string[] = [];
  let runsDir = mkdtempSync(join(tmpdir(), "dispatch-runs-"));
  let cwd = mkdtempSync(join(tmpdir(), "dispatch-cwd-"));

  const host: Host = {
    cwd: () => cwd,
    home: join(tmpdir(), "dispatch-no-home"),
    agentDir,
    projectTrusted: true,
    runsDir: () => runsDir,
    env: { ...process.env, PI_SUBAGENTS_PI_BIN: fakePi, ...extraEnv },
    notify: (message, level) => notices.push({ message, level }),
    sendResult: (message, record) => {
      results.push(record);
      messages.push(message);
    },
  };

  return {
    host,
    notices,
    results,
    messages,
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

test("a launch at the depth limit is refused and no run directory is written", () => {
  const fake = fakeHost("{}", { PI_SUBAGENTS_DEPTH: "3", PI_SUBAGENTS_MAX_DEPTH: "3" });

  assert.throws(
    () => createDispatcher(fake.host).dispatch("explorer", "Find the entry point"),
    (error: Error) => {
      assert.match(error.message, /depth 3/);
      assert.match(error.message, /limit of 3/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(fake.runsDir), []);
});

test("the child of a run inherits the depth, the limit and the ceiling", async () => {
  const envOut = join(mkdtempSync(join(tmpdir(), "dispatch-env-")), "env.json");
  const fake = fakeHost("{}", {
    PI_SUBAGENTS_DEPTH: "1",
    PI_SUBAGENTS_MAX_DEPTH: "2",
    FAKE_PI_ENV_OUT: envOut,
  });

  createDispatcher(fake.host).dispatch("explorer", "Find the entry point");
  while (fake.results.length === 0) await setTimeout(20);

  const childEnv: Record<string, string> = JSON.parse(readFileSync(envOut, "utf8"));
  assert.equal(childEnv.PI_SUBAGENTS_DEPTH, "2");
  assert.equal(childEnv.PI_SUBAGENTS_MAX_DEPTH, "2");
  assert.equal(childEnv.PI_SUBAGENTS_TOOL_CEILING, "read,grep,find,ls");
});

test("a ceiling narrows the launch, records the removal and does not fail", async () => {
  const fake = fakeHost("{}", { PI_SUBAGENTS_DEPTH: "1", PI_SUBAGENTS_TOOL_CEILING: "read,ls" });

  const launch = createDispatcher(fake.host).dispatch("explorer", "Find the entry point");
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(launch.status, "running");
  assert.match(launch.text, /may not grant grep, find/);
  const record = JSON.parse(readFileSync(join(launch.dir, "run.json"), "utf8"));
  assert.deepEqual(record.removedTools, ["grep", "find"]);
  assert.equal(record.depth, 2);
});

test("a child that spawns a grandchild passes the depth and the ceiling down", async () => {
  const nestDir = mkdtempSync(join(tmpdir(), "dispatch-nest-"));
  const grandchildEnv = join(nestDir, "grandchild-env.json");
  const fake = fakeHost("{}", {
    FAKE_PI_NEST: nestDir,
    FAKE_PI_NEST_AGENT: "gatherer",
    FAKE_PI_NEST_ENV_OUT: grandchildEnv,
  });

  // The child works in the project directory, so it finds these agent files.
  const agents = join(fake.cwd, CONFIG_DIR_NAME, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "splitter.md"), "---\ntools: [read, grep, subagent]\n---\nSplit.\n");
  writeFileSync(join(agents, "gatherer.md"), "---\ntools: [read, bash]\n---\nGather.\n");

  createDispatcher(fake.host).dispatch("splitter", "Split the work");
  while (fake.results.length === 0) await setTimeout(20);

  const env: Record<string, string> = JSON.parse(readFileSync(grandchildEnv, "utf8"));
  assert.equal(env.PI_SUBAGENTS_DEPTH, "2");
  assert.equal(env.PI_SUBAGENTS_MAX_DEPTH, "3");
  // The child may not grant bash, because its own agent file does not name it.
  assert.equal(env.PI_SUBAGENTS_TOOL_CEILING, "read");
});

/** The status in the record file of a run, which the child never writes. */
function fileStatus(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).status;
}

/**
 * A host whose children never exit. The caller stops every run it starts, or
 * the child holds the test process open.
 */
function hangingHost(userSettings: string): Fake {
  process.env.FAKE_PI_HANG = "1";
  try {
    return fakeHost(userSettings);
  } finally {
    delete process.env.FAKE_PI_HANG;
  }
}

test("a stopped run gets the stopped status and keeps its transcript", async () => {
  const fake = hangingHost("{}");
  const dispatcher = createDispatcher(fake.host);

  const launch = dispatcher.dispatch("explorer", "Find the entry point");
  // The child prints its events and then hangs. Stop it once it has written.
  const transcript = join(launch.dir, "transcript.jsonl");
  while (readFileSync(transcript, "utf8") === "") await setTimeout(20);

  assert.equal(dispatcher.stop(launch.id), `Stopped subagent run ${launch.id}.`);
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(fake.results[0].id, launch.id);
  assert.equal(fake.results[0].status, "stopped");
  assert.equal(fileStatus(launch.dir), "stopped");
  assert.match(fake.messages[0], /stopped before it finished/);
  assert.ok(readFileSync(transcript, "utf8").length > 0, "the transcript was dropped");
});

test("a run that passes the time limit is killed and fails", async () => {
  // 0.005 minutes is 300 milliseconds.
  const fake = hangingHost('{"timeoutMinutes": 0.005}');

  const launch = createDispatcher(fake.host).dispatch("explorer", "Find the entry point");
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(fake.results[0].status, "failed");
  assert.equal(fileStatus(launch.dir), "failed");
  assert.match(fake.messages[0], /passed its limit of .* and was killed/);
});

test("stopping an unknown run changes nothing", () => {
  const fake = fakeHost("{}");

  const message = createDispatcher(fake.host).stop("deadbeef");

  assert.match(message, /No subagent run "deadbeef"/);
  assert.equal(fake.results.length, 0);
});

test("stopping a finished run changes nothing", async () => {
  const fake = fakeHost("{}");
  const dispatcher = createDispatcher(fake.host);

  const launch = dispatcher.dispatch("explorer", "Find the entry point");
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(
    dispatcher.stop(launch.id),
    `Subagent run ${launch.id} already completed. Nothing changed.`,
  );
  assert.equal(fake.results.length, 1, "the finished run was reported twice");
  assert.equal(fileStatus(launch.dir), "completed");
});

test("a queued run is stopped before it starts a child", async () => {
  const fake = hangingHost('{"maxConcurrency": 1}');
  const dispatcher = createDispatcher(fake.host);

  const first = dispatcher.dispatch("explorer", "Find the entry point");
  const second = dispatcher.dispatch("explorer", "Find the tests");

  assert.equal(dispatcher.stop(second.id), `Stopped queued subagent run ${second.id}.`);
  while (fake.results.length === 0) await setTimeout(20);

  assert.equal(fake.results[0].id, second.id);
  assert.equal(fake.results[0].status, "stopped");

  // The first child still hangs, and it holds the only slot. Stopping it frees
  // the slot, and the stopped run must not start a child now.
  dispatcher.stop(first.id);
  while (fake.results.length < 2) await setTimeout(20);
  assert.equal(fake.results.length, 2);
});

test("the session shutdown stops the running child and the queued run", async () => {
  const fake = hangingHost('{"maxConcurrency": 1}');
  const dispatcher = createDispatcher(fake.host);

  const first = dispatcher.dispatch("explorer", "Find the entry point");
  const second = dispatcher.dispatch("explorer", "Find the tests");
  dispatcher.stopAll();
  while (fake.results.length < 2) await setTimeout(20);

  assert.deepEqual(
    fake.results.map((record) => record.status),
    ["stopped", "stopped"],
  );
  assert.match(fake.messages[0], /end of the pi session/);
  assert.equal(fileStatus(first.dir), "stopped");
  assert.equal(fileStatus(second.dir), "stopped");
});

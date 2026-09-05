import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentEntry } from "../src/agents.ts";
import {
  agentRows,
  inspectorKey,
  type InspectorRun,
  type InspectorState,
  readRuns,
  renderInspector,
} from "../src/inspector.ts";

const ESCAPE = "\u001b";
const DOWN = `${ESCAPE}[B`;
const UP = `${ESCAPE}[A`;
const RIGHT = `${ESCAPE}[C`;
const LEFT = `${ESCAPE}[D`;

function run(id: string, transcript: string[] = []): InspectorRun {
  return {
    id,
    agent: "explorer",
    model: "sonnet",
    status: "running",
    queuedAt: `2026-01-01T00:00:0${id}.000Z`,
    transcript,
  };
}

function state(runs: InspectorRun[], over: Partial<InspectorState> = {}): InspectorState {
  return { runs, selected: 0, focus: "runs", scroll: 0, ...over };
}

/** Every row of a view fills the width, and the view fills the height. */
function assertFillsScreen(lines: string[], width: number, height: number): void {
  assert.equal(lines.length, height);
  for (const line of lines) assert.equal([...line].length, width);
}

/** The transcript part of one row. The divider marks where the right pane starts. */
function transcriptOf(line: string): string {
  return line.slice(line.indexOf("\u2502") + 1).trimEnd();
}

/** The state after one key on an eighty by ten screen. The view stays open. */
function afterKey(from: InspectorState, key: string): InspectorState {
  const next = inspectorKey(from, key, 80, 10);
  assert.ok(next !== "close" && next !== "reload");
  return next;
}

test("an empty list says so and draws no error", () => {
  const lines = renderInspector(state([]), 80, 10);

  assertFillsScreen(lines, 80, 10);
  assert.ok(lines[0].startsWith("No subagent run in this session."));
  assert.ok(lines.at(-1)?.startsWith("q close"));
});

test("the list names the agent, the run id, the model and the status", () => {
  const lines = renderInspector(state([run("1")]), 80, 6);

  assert.ok(lines[0].startsWith("> explorer 1 sonnet running"));
});

test("a long model name does not push the status out of the list pane", () => {
  const long: InspectorRun = {
    ...run("1"),
    id: "a1b2c3d4",
    model: "anthropic/claude-opus-4-5",
    status: "completed",
  };

  const lines = renderInspector(state([long]), 80, 6);

  assert.equal(lines[0].slice(0, lines[0].indexOf("\u2502")).trimEnd().endsWith("completed"), true);
});

test("the selected run carries the marker and its transcript fills the right pane", () => {
  const runs = [run("1", ["first answer"]), run("2", ["second answer"])];

  const lines = renderInspector(state(runs, { selected: 1 }), 80, 6);

  assertFillsScreen(lines, 80, 6);
  assert.ok(lines[0].startsWith("  explorer 1"));
  assert.ok(lines[1].startsWith("> explorer 2"));
  assert.equal(transcriptOf(lines[0]), "second answer");
});

test("a narrow terminal shows the focused pane alone", () => {
  const runs = [run("1", ["the answer"])];

  const list = renderInspector(state(runs), 30, 6);
  const text = renderInspector(state(runs, { focus: "transcript" }), 30, 6);

  assertFillsScreen(list, 30, 6);
  assertFillsScreen(text, 30, 6);
  assert.ok(list[0].startsWith("> explorer 1"));
  assert.ok(!list[0].includes("the answer"));
  assert.ok(text[0].startsWith("the answer"));
});

test("a run with no output leaves the transcript pane empty", () => {
  const lines = renderInspector(state([run("1")]), 80, 5);

  assertFillsScreen(lines, 80, 5);
  assert.equal(transcriptOf(lines[0]), "");
});

test("the down key and the j key both move the selection", () => {
  const runs = [run("1"), run("2")];

  for (const key of [DOWN, "j"]) {
    assert.equal(afterKey(state(runs), key).selected, 1);
  }
});

test("the selection stays inside the list", () => {
  const runs = [run("1"), run("2")];

  assert.equal(afterKey(state(runs), UP).selected, 0);
  assert.equal(afterKey(state(runs, { selected: 1 }), "j").selected, 1);
});

test("the left and right keys move focus between the panes", () => {
  const runs = [run("1")];
  assert.equal(afterKey(state(runs), RIGHT).focus, "transcript");
  assert.equal(afterKey(state(runs), "l").focus, "transcript");
  assert.equal(afterKey(state(runs, { focus: "transcript" }), LEFT).focus, "runs");
  assert.equal(afterKey(state(runs, { focus: "transcript" }), "h").focus, "runs");
});

test("the focused transcript pane scrolls to the last line", () => {
  const text = Array.from({ length: 50 }, (_, index) => `line ${index}`);
  let current = state([run("1", text)], { focus: "transcript" });

  for (let press = 0; press < 200; press++) current = afterKey(current, "j");

  const lines = renderInspector(current, 80, 10);
  assert.equal(transcriptOf(lines[8]), "line 49");
});

test("the transcript goes back to the top when the selection moves", () => {
  const runs = [run("1", ["a"]), run("2", ["b"])];

  assert.equal(afterKey(state(runs, { scroll: 7 }), "j").scroll, 0);
});

test("the q key closes the view and the r key reloads it", () => {
  const runs = [run("1")];

  assert.equal(inspectorKey(state(runs), "q", 80, 10), "close");
  assert.equal(inspectorKey(state(runs), "r", 80, 10), "reload");
});

test("readRuns reads every run directory, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspector-"));
  const write = (id: string, queuedAt: string, transcript: string | undefined): void => {
    const runDir = join(dir, id);
    mkdirSync(runDir);
    const record = { id, agent: "explorer", model: null, queuedAt, status: "completed" };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(record));
    if (transcript !== undefined) writeFileSync(join(runDir, "transcript.jsonl"), transcript);
  };
  const message = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });

  write("bbbb", "2026-01-02T00:00:00.000Z", `${message}\n`);
  write("aaaa", "2026-01-01T00:00:00.000Z", undefined);

  const runs = readRuns(dir);

  assert.deepEqual(
    runs.map((found) => found.id),
    ["aaaa", "bbbb"],
  );
  assert.deepEqual(runs[0].transcript, []);
  assert.deepEqual(runs[1].transcript, ["done"]);
});

test("a missing runs directory gives no run", () => {
  assert.deepEqual(readRuns(join(tmpdir(), "no-such-runs-directory")), []);
});

test("the agent list names the tools and the root of every agent", () => {
  const entries: AgentEntry[] = [
    { name: "explorer", tools: ["read", "bash"], error: undefined, root: "/roots/bundled" },
    { name: "broken", tools: undefined, error: "No frontmatter block", root: "/roots/project" },
  ];

  const rows = agentRows(entries);

  assert.deepEqual(rows, [
    "explorer",
    "  tools: read, bash",
    "  root: /roots/bundled",
    "",
    "broken",
    "  unusable: No frontmatter block",
    "  root: /roots/project",
  ]);
});

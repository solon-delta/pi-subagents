import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentEntry } from "../src/agents.ts";
import {
  agentRows,
  elapsedText,
  inspectorKey,
  type InspectorRun,
  type InspectorState,
  PLAIN,
  readRuns,
  renderAgents,
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
    elapsed: "2m14s",
    task: "Map the path a tool call takes.",
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

/** The state after one key on an eighty by twelve screen. The view stays open. */
function afterKey(from: InspectorState, key: string): InspectorState {
  const next = inspectorKey(from, key, 80, 12);
  assert.ok(next !== "close" && next !== "reload" && next !== "stop");
  return next;
}

/** The run list part of one row, without the frame. */
function listOf(line: string): string {
  return line.slice(1, line.indexOf("│", 1)).trimEnd();
}

/** The transcript part of one row. The second bar marks where the pane starts. */
function transcriptOf(line: string): string {
  return line.slice(line.indexOf("│", 1) + 2, -1).trimEnd();
}

test("the view wears a frame with a title and a hint row under it", () => {
  const lines = renderInspector(state([run("1")]), PLAIN, 80, 12);

  assertFillsScreen(lines, 80, 12);
  assert.ok(lines[0].startsWith("╭─ fleet ─"));
  assert.ok(lines[0].endsWith("╮"));
  assert.ok(lines.at(-2)?.startsWith("╰─"));
  assert.ok(lines.at(-2)?.endsWith("╯"));
  assert.equal(lines.at(-1)?.trimEnd(), " ↑↓ select   ←→ pane   s stop   r reload   q close");
});

test("an empty list says so and draws no error", () => {
  const lines = renderInspector(state([]), PLAIN, 80, 12);

  assertFillsScreen(lines, 80, 12);
  assert.equal(listOf(lines[1]), " No run in this session.");
});

test("the list marks the status and names the agent, the run id and the model", () => {
  const lines = renderInspector(state([run("1")]), PLAIN, 80, 12);

  assert.equal(listOf(lines[1]), " ● explorer 1 sonnet");
});

test("every status has its own mark in the list", () => {
  const marks = (["queued", "completed", "failed", "stopped"] as const).map((status) => {
    const lines = renderInspector(state([{ ...run("1"), status }]), PLAIN, 80, 12);
    return listOf(lines[1]).trim().charAt(0);
  });

  assert.deepEqual(marks, ["○", "✓", "✗", "■"]);
});

test("the pane heads the transcript with the run and its task", () => {
  const lines = renderInspector(state([run("1", ["read index.ts"])]), PLAIN, 80, 12);

  assert.equal(transcriptOf(lines[1]), "explorer · 1 · sonnet · running · 2m14s");
  assert.equal(transcriptOf(lines[2]), "Map the path a tool call takes.");
  assert.equal(transcriptOf(lines[3]), "");
  assert.equal(transcriptOf(lines[4]), "read index.ts");
});

test("the selected run carries the marker and its transcript fills the right pane", () => {
  const runs = [run("1", ["first answer"]), run("2", ["second answer"])];

  const lines = renderInspector(state(runs, { selected: 1 }), PLAIN, 80, 12);

  assertFillsScreen(lines, 80, 12);
  assert.equal(listOf(lines[1]), " ● explorer 1 sonnet");
  assert.equal(listOf(lines[2]), " ● explorer 2 sonnet");
  assert.equal(transcriptOf(lines[4]), "second answer");
});

test("a narrow terminal shows the focused pane alone", () => {
  const runs = [run("1", ["the answer"])];

  const list = renderInspector(state(runs), PLAIN, 30, 12);
  const text = renderInspector(state(runs, { focus: "transcript" }), PLAIN, 30, 12);

  assertFillsScreen(list, 30, 12);
  assertFillsScreen(text, 30, 12);
  assert.ok(list[1].includes("explorer"));
  assert.ok(!list[1].includes("the answer"));
  assert.ok(text[1].includes("explorer · 1"));
});

test("a run with no output leaves the transcript under its head empty", () => {
  const lines = renderInspector(state([run("1")]), PLAIN, 80, 12);

  assertFillsScreen(lines, 80, 12);
  assert.equal(transcriptOf(lines[3]), "");
  assert.equal(transcriptOf(lines[4]), "");
});

test("a long model name does not push the status out of the pane head", () => {
  const long: InspectorRun = {
    ...run("1"),
    id: "a1b2c3d4",
    model: "anthropic/claude-opus-4-5",
    status: "completed",
  };

  const lines = renderInspector(state([long]), PLAIN, 100, 12);

  assert.ok(transcriptOf(lines[1]).includes("completed"));
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

  const lines = renderInspector(current, PLAIN, 80, 12);
  assert.equal(transcriptOf(lines.at(-3) ?? ""), "line 49");
});

test("the transcript goes back to the top when the selection moves", () => {
  const runs = [run("1", ["a"]), run("2", ["b"])];

  assert.equal(afterKey(state(runs, { scroll: 7 }), "j").scroll, 0);
});

test("the q key closes, the r key reloads, and the s key stops", () => {
  const runs = [run("1")];

  assert.equal(inspectorKey(state(runs), "q", 80, 12), "close");
  assert.equal(inspectorKey(state(runs), ESCAPE, 80, 12), "close");
  assert.equal(inspectorKey(state(runs), "r", 80, 12), "reload");
  assert.equal(inspectorKey(state(runs), "s", 80, 12), "stop");
});

test("elapsed counts to the end, and to now while the run still works", () => {
  const start = "2026-01-01T00:00:00.000Z";

  assert.equal(elapsedText(undefined, undefined, Date.parse(start)), "-");
  assert.equal(elapsedText(start, "2026-01-01T00:00:48.000Z", 0), "48s");
  assert.equal(elapsedText(start, "2026-01-01T00:02:14.000Z", 0), "2m14s");
  assert.equal(elapsedText(start, undefined, Date.parse(start) + 62_000), "1m02s");
});

test("readRuns gives every record its transcript and its elapsed text", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspector-"));
  const write = (id: string, queuedAt: string, transcript: string | undefined): void => {
    const runDir = join(dir, id);
    mkdirSync(runDir);
    const record = {
      id,
      agent: "explorer",
      model: null,
      depth: 1,
      removedTools: [],
      queuedAt,
      status: "completed",
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(record));
    if (transcript !== undefined) writeFileSync(join(runDir, "transcript.jsonl"), transcript);
  };
  const message = (role: string, text: string): string =>
    JSON.stringify({ type: "message_end", message: { role, content: [{ type: "text", text }] } });

  write(
    "bbbb",
    "2026-01-02T00:00:00.000Z",
    `${message("user", "the task")}\n${message("assistant", "done")}\n`,
  );
  write("aaaa", "2026-01-01T00:00:00.000Z", undefined);

  const runs = readRuns(dir);

  assert.deepEqual(
    runs.map((found) => found.id),
    ["aaaa", "bbbb"],
  );
  assert.deepEqual(runs[0].transcript, []);
  assert.equal(runs[0].task, "");
  assert.equal(runs[0].elapsed, "-");
  assert.deepEqual(runs[1].transcript, ["done"]);
  assert.equal(runs[1].task, "the task");
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

test("the agent list wears the same frame", () => {
  const rows = agentRows([
    { name: "explorer", tools: ["read"], error: undefined, root: "/roots/bundled" },
  ]);

  const lines = renderAgents(rows, PLAIN, 0, 60, 10);

  assertFillsScreen(lines, 60, 10);
  assert.ok(lines[0].startsWith("╭─ agents ─"));
  assert.equal(lines[1].slice(2, -1).trimEnd(), "explorer");
});

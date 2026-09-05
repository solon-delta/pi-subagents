import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentEntry } from "./agents.ts";
import { type RunStatus, RunStatusSchema } from "./run-record.ts";
import { readTranscript } from "./transcript.ts";

/** One run of the session, as the inspector shows it. */
export interface InspectorRun {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  status: RunStatus;
  /** ISO timestamp. The list is sorted by it, so the oldest run is first. */
  queuedAt: string;
  /** The transcript. An empty list means that the run has printed nothing. */
  transcript: string[];
}

export type Pane = "runs" | "transcript";

/** What the inspector shows. Every key gives a new one of these. */
export interface InspectorState {
  runs: InspectorRun[];
  /** Index in the run list. It stays inside the list. */
  selected: number;
  focus: Pane;
  /** First transcript row on screen. */
  scroll: number;
}

/**
 * The fields of run.json that the inspector reads. The file carries more, and
 * an older file of an earlier version may carry less, so a run that fails this
 * check drops out of the list instead of breaking it.
 */
const RunFile = Type.Object({
  id: Type.String(),
  agent: Type.String(),
  model: Type.Union([Type.String(), Type.Null()]),
  queuedAt: Type.String(),
  status: RunStatusSchema,
});

/**
 * Read every run of a runs directory, oldest first. A missing directory gives
 * no run, and a directory without a readable run.json drops out. The read
 * happens once per call: the view reloads on a key and follows no child.
 */
export function readRuns(runsDir: string): InspectorRun[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: InspectorRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);

    let record: unknown;
    try {
      record = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    } catch {
      continue;
    }
    if (!Value.Check(RunFile, record)) continue;

    runs.push({ ...record, transcript: readTranscript(dir) });
  }

  return runs.sort((one, other) => one.queuedAt.localeCompare(other.queuedAt));
}

/** The bottom row of every view. It names the keys that the view takes. */
const HINT = "q close   jk select   hl pane   r reload";
const AGENT_HINT = "q close   jk scroll";
const EMPTY_LIST = "No subagent run in this session.";

/** A terminal below this width holds one pane. The focused pane takes it. */
const TWO_PANE_WIDTH = 40;

/**
 * The widest that the run list gets. A row holds four fields, and the status is
 * the last of them, so a narrow list pane cuts away the field the user scans
 * for. The list therefore takes a little more than half of a wide terminal.
 */
const LIST_CEILING = 46;
const LIST_SHARE = 0.55;

/** The widest model name in a row. A long name would push the status away. */
const MODEL_WIDTH = 12;

const ESCAPE = "\u001b";
const UP = new Set([`${ESCAPE}[A`, "k"]);
const DOWN = new Set([`${ESCAPE}[B`, "j"]);
const RIGHT = new Set([`${ESCAPE}[C`, "l"]);
const LEFT = new Set([`${ESCAPE}[D`, "h"]);

/** Keep a value inside the list. A count of zero gives the first index. */
function clamp(value: number, count: number): number {
  return Math.max(0, Math.min(value, count - 1));
}

/** The first row on screen. The last row of the text reaches the bottom row. */
function clampScroll(value: number, total: number, rows: number): number {
  return Math.max(0, Math.min(value, total - rows));
}

// ponytail: every width here counts UTF-16 units. A CJK character or an emoji
// therefore shifts the divider by a column. Take the visibleWidth helper of the
// host TUI package when a user reads a transcript in such a script.
function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width).slice(0, width);
}

/** Break every line at the pane width, so a long line stays readable. */
function wrap(lines: string[], width: number): string[] {
  if (width <= 0) return [];

  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    for (let at = 0; at < line.length; at += width) out.push(line.slice(at, at + width));
  }
  return out;
}

/** The columns of the two panes. A width of zero means that the pane stays away. */
interface PaneWidths {
  left: number;
  right: number;
}

/** How the terminal width is shared. A narrow terminal gives the focused pane all of it. */
function paneWidths(width: number, focus: Pane): PaneWidths {
  if (width < TWO_PANE_WIDTH) {
    return focus === "runs" ? { left: width, right: 0 } : { left: 0, right: width };
  }
  const left = Math.min(LIST_CEILING, Math.floor(width * LIST_SHARE));
  return { left, right: width - left - 1 };
}

/** One row per run: the agent name, the run id, the model and the status. */
function runRows(state: InspectorState): string[] {
  if (state.runs.length === 0) return [EMPTY_LIST];

  return state.runs.map((run, index) => {
    // The arrow says which run is selected, and it fills only while the list
    // has the keys, so the user sees where a key goes.
    const mark = index !== state.selected ? "  " : state.focus === "runs" ? "> " : "· ";
    const model = truncate(run.model ?? "-", MODEL_WIDTH);
    return `${mark}${run.agent} ${run.id} ${model} ${run.status}`;
  });
}

/** The transcript rows of the selected run, broken at the pane width. */
function transcriptRows(state: InspectorState, width: number): string[] {
  return wrap(state.runs[state.selected]?.transcript ?? [], width);
}

/** How many rows the panes get. The last row of the view carries the hint. */
function paneRows(height: number): number {
  return Math.max(1, height - 1);
}

/**
 * The whole view, one string per terminal row. No row is wider than the width,
 * and the view always fills the height, so nothing of an earlier screen stays.
 */
export function renderInspector(state: InspectorState, width: number, height: number): string[] {
  const rows = paneRows(height);
  const { left, right } = paneWidths(width, state.focus);
  const list = runRows(state);
  const transcript = transcriptRows(state, right);

  // The selected run stays on screen once the list is longer than the pane.
  const listTop = Math.max(0, state.selected - rows + 1);
  const scrollTop = clampScroll(state.scroll, transcript.length, rows);

  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const listRow = truncate(list[listTop + row] ?? "", left);
    const textRow = truncate(transcript[scrollTop + row] ?? "", right);
    if (right === 0) lines.push(pad(listRow, left));
    else if (left === 0) lines.push(pad(textRow, right));
    else lines.push(`${pad(listRow, left)}│${pad(textRow, right)}`);
  }

  lines.push(pad(truncate(HINT, width), width));
  return lines;
}

/**
 * What one key does. The view closes on "close" and reads the files again on
 * "reload". Every other key gives the next state, which may be the state that
 * came in.
 */
export function inspectorKey(
  state: InspectorState,
  key: string,
  width: number,
  height: number,
): InspectorState | "close" | "reload" {
  if (key === "q" || key === ESCAPE) return "close";
  if (key === "r") return "reload";
  if (LEFT.has(key)) return { ...state, focus: "runs" };
  if (RIGHT.has(key)) return { ...state, focus: "transcript" };

  const step = UP.has(key) ? -1 : DOWN.has(key) ? 1 : 0;
  if (step === 0) return state;

  if (state.focus === "runs") {
    // A new run brings its own transcript, which starts at the top.
    return { ...state, selected: clamp(state.selected + step, state.runs.length), scroll: 0 };
  }

  // The last row of the transcript reaches the bottom of the pane, and no key
  // scrolls past it.
  const total = transcriptRows(state, paneWidths(width, state.focus).right).length;
  return { ...state, scroll: clampScroll(state.scroll + step, total, paneRows(height)) };
}

/** One block per agent: the name, the tools, and the root that carries the file. */
export function agentRows(entries: AgentEntry[]): string[] {
  if (entries.length === 0) return ["No agent file in any root."];

  const rows: string[] = [];
  for (const entry of entries) {
    rows.push(entry.name);
    if (entry.error === undefined) rows.push(`  tools: ${entry.tools?.join(", ") || "none"}`);
    else rows.push(`  unusable: ${entry.error}`);
    rows.push(`  root: ${entry.root}`);
    rows.push("");
  }
  rows.pop();
  return rows;
}

/** The agent list, one string per terminal row. It scrolls and has no pane. */
export function renderAgents(
  rows: string[],
  scroll: number,
  width: number,
  height: number,
): string[] {
  const count = paneRows(height);
  const wrapped = wrap(rows, width);
  const top = clampScroll(scroll, wrapped.length, count);

  const lines: string[] = [];
  for (let row = 0; row < count; row++) lines.push(pad(wrapped[top + row] ?? "", width));

  lines.push(pad(truncate(AGENT_HINT, width), width));
  return lines;
}

/** What one key does in the agent list. It scrolls or it closes. */
function agentsKey(
  scroll: number,
  key: string,
  rows: string[],
  width: number,
  height: number,
): number | "close" {
  if (key === "q" || key === ESCAPE) return "close";

  const step = UP.has(key) ? -1 : DOWN.has(key) ? 1 : 0;
  return clampScroll(scroll + step, wrap(rows, width).length, paneRows(height));
}

/**
 * One full screen view of this extension. It holds its own state and answers
 * two questions of the host: what to draw, and what a key does.
 */
export interface View {
  render(width: number, height: number): string[];
  /** True when the key closed the view. */
  key(data: string, width: number, height: number): boolean;
}

/**
 * The run inspector. It reads the runs directory now, and again on a reload
 * key. It never follows a running child on a timer.
 */
export function inspectorView(runsDir: string): View {
  let state: InspectorState = { runs: readRuns(runsDir), selected: 0, focus: "runs", scroll: 0 };

  return {
    render: (width, height) => renderInspector(state, width, height),

    key(data, width, height) {
      const next = inspectorKey(state, data, width, height);
      if (next === "close") return true;

      if (next === "reload") {
        // A run may be gone from the list, so the selection comes back inside.
        const runs = readRuns(runsDir);
        state = { ...state, runs, selected: clamp(state.selected, runs.length) };
      } else {
        state = next;
      }
      return false;
    },
  };
}

/** The agent list. The catalogue is read once, when the session starts. */
export function agentsView(entries: AgentEntry[]): View {
  const rows = agentRows(entries);
  let scroll = 0;

  return {
    render: (width, height) => renderAgents(rows, scroll, width, height),

    key(data, width, height) {
      const next = agentsKey(scroll, data, rows, width, height);
      if (next === "close") return true;
      scroll = next;
      return false;
    },
  };
}

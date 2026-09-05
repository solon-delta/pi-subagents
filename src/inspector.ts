import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentEntry } from "./agents.ts";
import { type RunStatus, RunStatusSchema } from "./run-record.ts";
import { readTranscript } from "./transcript.ts";

/**
 * The part of the pi theme that these views paint with. The real Theme of pi
 * satisfies it, and a test passes a plain object that returns its text, so a
 * rendered row is exactly as wide as the columns it fills.
 */
export interface Paint {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** One run of the session, as the inspector shows it. */
export interface InspectorRun {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  status: RunStatus;
  /** ISO timestamp. The list is sorted by it, so the oldest run is first. */
  queuedAt: string;
  /** How long the run worked, as in 2m14s. A queued run has no time yet. */
  elapsed: string;
  /** The task of the run, read from its transcript. */
  task: string;
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
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  status: RunStatusSchema,
});

/**
 * How long a run has worked. A run that still works counts up to the moment of
 * the read, so the view shows a snapshot and follows no child on a timer.
 */
export function elapsedText(
  startedAt: string | undefined,
  endedAt: string | undefined,
  now: number,
): string {
  if (startedAt === undefined) return "-";
  const end = endedAt === undefined ? now : Date.parse(endedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

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

  const now = Date.now();
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

    const transcript = readTranscript(dir);
    runs.push({
      id: record.id,
      agent: record.agent,
      model: record.model,
      status: record.status,
      queuedAt: record.queuedAt,
      elapsed: elapsedText(record.startedAt, record.endedAt, now),
      task: transcript.task,
      transcript: transcript.rows,
    });
  }

  return runs.sort((one, other) => one.queuedAt.localeCompare(other.queuedAt));
}

/** The mark of each status in the run list. The colour carries the same fact. */
const MARK = {
  queued: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  stopped: "■",
} satisfies Record<RunStatus, string>;

const COLOUR = {
  queued: "muted",
  running: "accent",
  completed: "success",
  failed: "error",
  stopped: "warning",
} satisfies Record<RunStatus, string>;

/** The row under the frame. It names every key that the view takes. */
const HINT = " ↑↓ select   ←→ pane   s stop   r reload   q close";
/** The same keys for a terminal too narrow to read the row above. */
const SHORT_HINT = " ↑↓ ←→   s stop   r reload   q close";
const AGENT_HINT = " ↑↓ scroll   q close";
const EMPTY_LIST = "No run in this session.";

/** A terminal below this width holds one pane. The focused pane takes it. */
const TWO_PANE_WIDTH = 44;

/**
 * The widest that the run list gets, and its share of a narrower terminal. A
 * row holds a mark, the agent, the run id and the model, and the transcript
 * needs the rest.
 */
const LIST_CEILING = 32;
const LIST_SHARE = 0.38;

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
// therefore shifts the frame by a column. Take the visibleWidth helper of the
// host TUI package when a user reads a transcript in such a script.
/** Cut or fill a plain string to an exact width. Paint it after this call. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/** Break every line to the pane width, so a long line stays readable. */
function wrap(lines: string[], width: number): string[] {
  if (width <= 0) return [];

  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }

    let rest = line;
    while (rest.length > width) {
      // Break at the last space that still fits. A word wider than the pane
      // has no space to use, so it breaks at the edge.
      const space = rest.lastIndexOf(" ", width);
      const cut = space > 0 ? space : width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(space > 0 ? cut + 1 : cut);
    }
    if (rest !== "") out.push(rest);
  }
  return out;
}

/** The columns of the two panes. A width of zero means that the pane stays away. */
interface PaneWidths {
  left: number;
  right: number;
}

/**
 * How the inside of the frame is shared. The frame takes four columns: a side
 * bar, the divider with a space after it, and the closing side bar. A narrow
 * terminal drops one pane and gives the focused pane everything.
 */
function paneWidths(width: number, focus: Pane): PaneWidths {
  const inside = Math.max(0, width - 4);
  if (width < TWO_PANE_WIDTH) {
    // One pane, with a side bar on each side of it.
    const only = Math.max(0, width - 2);
    return focus === "runs" ? { left: only, right: 0 } : { left: 0, right: only };
  }
  const left = Math.min(LIST_CEILING, Math.floor(width * LIST_SHARE));
  return { left, right: inside - left };
}

/** One row per run: the status mark, the agent name, the run id and the model. */
function runRows(state: InspectorState, theme: Paint, width: number): string[] {
  if (state.runs.length === 0) return [theme.fg("dim", fit(` ${EMPTY_LIST}`, width))];

  return state.runs.map((run, index) => {
    const mark = theme.fg(COLOUR[run.status], MARK[run.status]);
    const label = fit(`${run.agent} ${run.id} ${run.model ?? "-"}`, Math.max(0, width - 3));
    const selected = index === state.selected;
    const line = ` ${mark} ${selected ? theme.bold(label) : theme.fg("text", label)}`;
    // The selected run keeps its band while the transcript has the keys, so the
    // user never loses the place that the up and down keys move.
    return selected && state.focus === "runs" ? theme.bg("selectedBg", line) : line;
  });
}

/**
 * The right pane of the selected run: a header, the task, and the transcript.
 * The three scroll together, so a long transcript reaches its last line.
 */
function transcriptRows(state: InspectorState, theme: Paint, width: number): string[] {
  const run = state.runs[state.selected];
  if (run === undefined || width <= 0) return [];

  const head = `${run.agent} · ${run.id} · ${run.model ?? "-"} · ${run.status} · ${run.elapsed}`;
  const rows = [theme.bold(fit(head, width))];
  // A run that has printed nothing yet has no task line either.
  for (const line of wrap(run.task === "" ? [] : [run.task], width)) {
    rows.push(theme.fg("dim", fit(line, width)));
  }
  rows.push(fit("", width));
  for (const line of wrap(run.transcript, width)) {
    rows.push(theme.fg("toolOutput", fit(line, width)));
  }
  return rows;
}

/** How many rows the frame holds. The frame takes two, the hint row one. */
function paneRows(height: number): number {
  return Math.max(1, height - 3);
}

/** The top of the frame, with the title in its top rule. */
function frameTop(theme: Paint, title: string, width: number): string {
  const rule = Math.max(0, width - title.length - 5);
  return theme.fg("border", `╭─ ${title} ${"─".repeat(rule)}╮`);
}

function frameBottom(theme: Paint, width: number): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/**
 * The whole view, one string per terminal row. No row is wider than the width,
 * and the view always fills the height, so nothing of an earlier screen stays.
 */
export function renderInspector(
  state: InspectorState,
  theme: Paint,
  width: number,
  height: number,
): string[] {
  const rows = paneRows(height);
  const { left, right } = paneWidths(width, state.focus);
  const list = runRows(state, theme, left);
  const transcript = transcriptRows(state, theme, right);
  const bar = theme.fg("border", "│");

  // The selected run stays on screen once the list is longer than the frame.
  const listTop = Math.max(0, state.selected - rows + 1);
  const scrollTop = clampScroll(state.scroll, transcript.length, rows);

  const lines = [frameTop(theme, "fleet", width)];
  for (let row = 0; row < rows; row++) {
    const listRow = list[listTop + row] ?? fit("", left);
    const textRow = transcript[scrollTop + row] ?? fit("", right);
    if (right === 0) lines.push(`${bar}${listRow}${bar}`);
    else if (left === 0) lines.push(`${bar}${textRow}${bar}`);
    else lines.push(`${bar}${listRow}${bar} ${textRow}${bar}`);
  }
  lines.push(frameBottom(theme, width));
  lines.push(theme.fg("dim", fit(width < TWO_PANE_WIDTH ? SHORT_HINT : HINT, width)));
  return lines;
}

/** What the `s` key asks of the host: stop this run, then read the files again. */
export type InspectorAction = "close" | "reload" | "stop";

/**
 * What one key does. The view closes on "close", reads the files again on
 * "reload", and stops the selected run on "stop". Every other key gives the
 * next state, which may be the state that came in.
 */
export function inspectorKey(
  state: InspectorState,
  key: string,
  width: number,
  height: number,
): InspectorState | InspectorAction {
  if (key === "q" || key === ESCAPE) return "close";
  if (key === "r") return "reload";
  if (key === "s") return "stop";
  if (LEFT.has(key)) return { ...state, focus: "runs" };
  if (RIGHT.has(key)) return { ...state, focus: "transcript" };

  const step = UP.has(key) ? -1 : DOWN.has(key) ? 1 : 0;
  if (step === 0) return state;

  if (state.focus === "runs") {
    // A new run brings its own transcript, which starts at the top.
    return { ...state, selected: clamp(state.selected + step, state.runs.length), scroll: 0 };
  }

  // The last row of the transcript reaches the bottom of the frame, and no key
  // scrolls past it. The paint does not change a row count, so a plain theme
  // measures the same text that the screen shows.
  const total = transcriptRows(state, PLAIN, paneWidths(width, state.focus).right).length;
  return { ...state, scroll: clampScroll(state.scroll + step, total, paneRows(height)) };
}

/** A theme that paints nothing. Row counts and widths are the same under it. */
export const PLAIN: Paint = {
  fg: (_colour, text) => text,
  bg: (_colour, text) => text,
  bold: (text) => text,
};

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

/** The agent list. It wears the same frame and scrolls in one pane. */
export function renderAgents(
  rows: string[],
  theme: Paint,
  scroll: number,
  width: number,
  height: number,
): string[] {
  const count = paneRows(height);
  // A side bar on each side, and one space of padding after the left bar.
  const inside = Math.max(0, width - 3);
  const wrapped = wrap(rows, inside);
  const top = clampScroll(scroll, wrapped.length, count);
  const bar = theme.fg("border", "│");

  const lines = [frameTop(theme, "agents", width)];
  for (let row = 0; row < count; row++) {
    lines.push(`${bar} ${theme.fg("text", fit(wrapped[top + row] ?? "", inside))}${bar}`);
  }
  lines.push(frameBottom(theme, width));
  lines.push(theme.fg("dim", fit(AGENT_HINT, width)));
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
  const wrapped = wrap(rows, Math.max(0, width - 3));
  return clampScroll(scroll + step, wrapped.length, paneRows(height));
}

/**
 * One full screen view of this extension. It holds its own state and answers
 * two questions of the host: what to draw, and what a key does.
 */
export interface View {
  render(theme: Paint, width: number, height: number): string[];
  /** True when the key closed the view. */
  key(data: string, width: number, height: number): boolean;
}

/**
 * The run inspector. It reads the runs directory now, and again on a reload
 * key. It never follows a running child on a timer.
 *
 * The stop function is the stop path of the session dispatcher. A session that
 * has launched nothing has no dispatcher and no run, so the list is empty and
 * the `s` key finds nothing to stop.
 */
export function inspectorView(runsDir: string, stop: (runId: string) => void): View {
  let state: InspectorState = { runs: readRuns(runsDir), selected: 0, focus: "runs", scroll: 0 };

  /** Read the files again and keep the selection inside the new list. */
  const reload = (): void => {
    const runs = readRuns(runsDir);
    state = { ...state, runs, selected: clamp(state.selected, runs.length) };
  };

  return {
    render: (theme, width, height) => renderInspector(state, theme, width, height),

    key(data, width, height) {
      const next = inspectorKey(state, data, width, height);
      if (next === "close") return true;

      if (next === "reload") reload();
      else if (next === "stop") {
        // The dispatcher owns what a stop means. A run that already ended
        // changes nothing there, so the view asks without a check of its own.
        const run = state.runs[state.selected];
        if (run !== undefined) stop(run.id);
        reload();
      } else state = next;

      return false;
    },
  };
}

/** The agent list. The catalogue is read when the command opens the view. */
export function agentsView(entries: AgentEntry[]): View {
  const rows = agentRows(entries);
  let scroll = 0;

  return {
    render: (theme, width, height) => renderAgents(rows, theme, scroll, width, height),

    key(data, width, height) {
      const next = agentsKey(scroll, data, rows, width, height);
      if (next === "close") return true;
      scroll = next;
      return false;
    },
  };
}

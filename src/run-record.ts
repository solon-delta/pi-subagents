import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const FILE_NAME = "run.json";

/**
 * The status of a run. The schema is here, next to the writer of the file, so a
 * reader of run.json checks against the list that this module keeps.
 */
export const RunStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("stopped"),
]);

export type RunStatus = Static<typeof RunStatusSchema>;

/**
 * What `run.json` holds. The schema stands next to the write below, so a field
 * is added in one place, and the reader checks the same list that the writer
 * fills. A file that fails this check drops out of a read instead of breaking
 * it: an older file of an earlier version carries less than this.
 */
export const RunRecordSchema = Type.Object({
  id: Type.String(),
  agent: Type.String(),
  /** The model of the agent file, or null when the agent file names none. */
  model: Type.Union([Type.String(), Type.Null()]),
  /** Nesting depth of the child. A run of the user session has depth one. */
  depth: Type.Number(),
  /** Tool names of the agent file that the ceiling of the parent removed. */
  removedTools: Type.Array(Type.String()),
  /** ISO timestamps. A queued run has no start time and no end time. */
  queuedAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  status: RunStatusSchema,
});

/** The type follows the schema, so the two cannot drift apart. */
export type RunRecord = Static<typeof RunRecordSchema>;

/** What a run is, before it has a history. The driver knows these facts. */
export type RunFacts = Omit<RunRecord, "queuedAt" | "startedAt" | "endedAt" | "status">;

/**
 * The record of one run, and the state machine of its status. The driver
 * reports events here, and never sets a status itself.
 */
export interface RunRecordFile {
  /** The record as it stands. The caller reads it and does not write it. */
  readonly record: RunRecord;
  /** True while the run can still be stopped: it waits for a slot, or it runs. */
  readonly live: boolean;
  /** True once the run has started. A run that waits for a slot has not. */
  readonly started: boolean;
  /** The child was spawned. */
  start(): void;
  /**
   * The run is killed, by a stop of the caller or by the time limit. A queued
   * run ends here, because it has no child that can close.
   */
  kill(status: "failed" | "stopped"): void;
  /** The child process closed. The exit code says whether it went well. */
  close(ok: boolean): void;
}

/**
 * Read the record of every run of a runs directory, oldest first. A missing
 * directory gives no record, and a directory whose `run.json` is missing or
 * fails the check drops out. The sort is here, because the order of the runs
 * follows the queue time that this module stamps.
 */
export function readRunRecords(runsDir: string): RunRecord[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(runsDir, entry.name, FILE_NAME), "utf8"));
    } catch {
      continue;
    }
    if (Value.Check(RunRecordSchema, parsed)) records.push(parsed);
  }

  return records.sort((one, other) => one.queuedAt.localeCompare(other.queuedAt));
}

/**
 * Give a run its record and hand back the state machine. The file `run.json` in
 * the run directory holds the record, and this module alone writes that file.
 */
export function createRunRecord(dir: string, facts: RunFacts): RunRecordFile {
  const record: RunRecord = {
    ...facts,
    queuedAt: new Date().toISOString(),
    startedAt: undefined,
    endedAt: undefined,
    status: "queued",
  };

  const write = (): void => {
    writeFileSync(join(dir, FILE_NAME), `${JSON.stringify(record, null, 2)}\n`);
  };
  write();

  // The two questions below are not opposites. A killed run that still waits
  // for its child to close is neither live nor ended: the kill took its status,
  // and the close brings its end time.
  /** A run with an end time is done. No later event changes it. */
  const ended = (): boolean => record.endedAt !== undefined;
  const live = (): boolean => record.status === "queued" || record.status === "running";

  return {
    get record() {
      return record;
    },
    get live() {
      return live();
    },
    get started() {
      return record.startedAt !== undefined;
    },

    start() {
      if (record.status !== "queued") return;
      record.startedAt = new Date().toISOString();
      record.status = "running";
      write();
    },

    kill(status) {
      if (!live()) return;
      // A queued run has no child, so nothing closes later, and the run ends
      // here. A running run keeps its end time for the close of its child: the
      // pi session kills its children and exits without a wait for them, and
      // this write is the one that takes the status out of "running".
      if (record.status === "queued") record.endedAt = new Date().toISOString();
      record.status = status;
      write();
    },

    close(ok) {
      if (ended()) return;
      record.endedAt = new Date().toISOString();
      // A killed run already has its status. Only a run that still says
      // "running" takes the answer of the exit code.
      if (record.status === "running") record.status = ok ? "completed" : "failed";
      write();
    },
  };
}

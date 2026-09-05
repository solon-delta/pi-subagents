import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Static, Type } from "typebox";

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

/** What a run is, before it has a history. The driver knows these facts. */
export interface RunFacts {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  /** Nesting depth of the child. A run of the user session has depth one. */
  depth: number;
  /** Tool names of the agent file that the ceiling of the parent removed. */
  removedTools: string[];
}

export interface RunRecord extends RunFacts {
  /** ISO timestamps. A queued run has no start time and no end time. */
  queuedAt: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  status: RunStatus;
}

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
    writeFileSync(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
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

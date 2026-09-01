import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { AgentDefinition } from "./agent-file.ts";
import { assistantText } from "./transcript.ts";

export type RunStatus = "completed" | "failed" | "queued" | "running";

export interface RunRecord {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  /** ISO timestamps. A queued run has no start time and no end time. */
  queuedAt: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  status: RunStatus;
}

/** The message that carries a finished run back into the parent conversation. */
export function resultMessage(record: RunRecord, text: string): string {
  const head = `Subagent "${record.agent}" (run ${record.id}) ${record.status}.`;
  return text === "" ? head : `${head}\n\n${text}`;
}

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  /** Working directory of the child. */
  cwd: string;
  /** Directory that holds one subdirectory per run. */
  runsDir: string;
  env: NodeJS.ProcessEnv;
}

export interface RunOutcome {
  record: RunRecord;
  /** The message that goes back into the parent conversation. */
  message: string;
}

export interface PreparedRun {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  record: RunRecord;
  options: RunOptions;
}

/**
 * The path of the pi executable. The environment variable is the single test
 * seam: a test points it at a fake pi script.
 */
function piExecutable(env: NodeJS.ProcessEnv): string {
  return env.PI_SUBAGENTS_PI_BIN ?? "pi";
}

/**
 * The command line of one child run. The task text is not here: pi reads a
 * positional argument that starts with "@" as a file path, and it has no escape
 * for that, so the task goes to the child on stdin.
 */
function childArguments(agent: AgentDefinition): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
  ];

  if (agent.tools.length === 0) args.push("--no-tools");
  else args.push("--tools", agent.tools.join(","));

  if (agent.model !== undefined) args.push("--model", agent.model);

  // An empty body still sends the flag. A replace agent with an empty body asks
  // for an empty system prompt, not for the pi default prompt.
  const flag = agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
  args.push(flag, agent.systemPrompt);

  return args;
}

function writeRecord(dir: string, record: RunRecord): void {
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Give a run its id, its directory and its record. The child does not run yet,
 * so the record says "queued" until startRun spawns it.
 */
export function prepareRun(options: RunOptions): PreparedRun {
  const id = randomBytes(4).toString("hex");
  const dir = join(options.runsDir, id);
  mkdirSync(dir, { recursive: true });

  const record: RunRecord = {
    id,
    agent: options.agent.name,
    model: options.agent.model ?? null,
    queuedAt: new Date().toISOString(),
    startedAt: undefined,
    endedAt: undefined,
    status: "queued",
  };
  writeRecord(dir, record);
  writeFileSync(join(dir, "transcript.jsonl"), "");

  return { id, dir, record, options };
}

/** Start the child pi process of a prepared run. Resolves when the child ends. */
export function startRun(run: PreparedRun): Promise<RunOutcome> {
  const { dir, record, options } = run;
  const transcript = join(dir, "transcript.jsonl");

  record.startedAt = new Date().toISOString();
  record.status = "running";
  writeRecord(dir, record);

  const args = childArguments(options.agent);
  const child = spawn(piExecutable(options.env), args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // The task goes on stdin. See the comment on childArguments.
  child.stdin.on("error", () => {});
  child.stdin.end(options.task);

  const lines: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    lines.push(line);
    appendFileSync(transcript, `${line}\n`);
  });

  return new Promise<RunOutcome>((resolve) => {
    // A failed spawn emits "error" and then "close", so both handlers run. The
    // first one owns the outcome and the last write of the record.
    let settled = false;
    const finish = (ok: boolean, failure: string): void => {
      if (settled) return;
      settled = true;

      record.endedAt = new Date().toISOString();
      record.status = ok ? "completed" : "failed";
      writeRecord(dir, record);
      const text = assistantText(lines);
      resolve({ record, message: resultMessage(record, text === "" ? failure : text) });
    };

    // The reader flushes a last line without a newline when stdout ends, which
    // can be after the process itself is gone.
    const streamEnded = new Promise<void>((done) => reader.on("close", () => done()));

    child.on("error", (error) => finish(false, `The child did not start: ${error.message}`));
    child.on("close", (code) => {
      streamEnded.then(() => finish(code === 0, errors.join("").trim()));
    });
  });
}

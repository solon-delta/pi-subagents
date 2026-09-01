import { loadAgent } from "./agents.ts";
import { createRunQueue } from "./queue.ts";
import { prepareRun, type RunRecord, startRun } from "./run.ts";
import { loadSettings, settingsFiles } from "./settings.ts";

/**
 * What the dispatch module needs from the host. Every fact is a plain value or
 * a plain function, so a test supplies its own host.
 */
export interface Host {
  /** Working directory of the parent session. It is read again on every launch. */
  cwd(): string;
  /** Home directory of the user. */
  home: string;
  /** The pi agent directory, which holds the user settings file. */
  agentDir: string;
  /** True when the user trusts the project, which opens the project settings. */
  projectTrusted: boolean;
  /** Directory that holds one subdirectory per run. It is read on every launch. */
  runsDir(): string;
  env: NodeJS.ProcessEnv;
  notify(message: string, level: "error" | "warning"): void;
  /** Carry a finished run back into the parent conversation. */
  sendResult(message: string, record: RunRecord): void;
}

export interface Launch {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  /** "running" when a slot was free, "queued" when every slot was taken. */
  status: "queued" | "running";
  /** The answer of the tool call, for the model that asked for the run. */
  text: string;
}

export interface Dispatcher {
  /** Launch one agent on one task. The child works after this returns. */
  dispatch(agent: string, task: string): Launch;
}

/**
 * One dispatcher per session. It reads the settings once, because the caller
 * builds it on the first tool call, when the project trust decision is settled.
 * A changed settings file needs a new session.
 */
export function createDispatcher(host: Host): Dispatcher {
  const loaded = loadSettings(settingsFiles(host.agentDir, host.cwd(), host.projectTrusted));
  if (loaded.warning !== undefined) host.notify(loaded.warning, "warning");
  const settings = loaded.settings;

  // The queue outlives the parent turn, so a queued run still starts later.
  const queue = createRunQueue(settings.maxConcurrency);

  return {
    dispatch(name, task) {
      // The working directory of the session can move between two tool calls,
      // so the launch reads it now and not when the dispatcher was built.
      const cwd = host.cwd();
      const agent = loadAgent(name, settings, cwd, host.home);
      const run = prepareRun({
        agent,
        task,
        cwd,
        runsDir: host.runsDir(),
        env: host.env,
      });

      const started = queue.add(() =>
        startRun(run).then(
          (outcome) => host.sendResult(outcome.message, outcome.record),
          (error: Error) =>
            host.notify(`Subagent run ${run.id} was lost: ${error.message}`, "error"),
        ),
      );

      const head = started
        ? `Started subagent "${agent.name}" as run ${run.id}.`
        : `Queued subagent "${agent.name}" as run ${run.id}. It starts when a slot is free.`;

      return {
        id: run.id,
        dir: run.dir,
        status: started ? "running" : "queued",
        text: `${head} Do not poll for the result.`,
      };
    },
  };
}

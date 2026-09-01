import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { agentRoots, loadAgent } from "./src/agents.ts";
import { createRunQueue, type RunQueue } from "./src/queue.ts";
import { prepareRun, startRun } from "./src/run.ts";
import { loadSettings, type Settings, settingsFiles, withDefaultModel } from "./src/settings.ts";

const DESCRIPTION = [
  "Delegate a task to a named subagent that runs in its own pi process.",
  "The tool returns a run id at once and the child works in the background.",
  "Do not poll for the result. The answer arrives on its own as a new turn.",
].join(" ");

export default function (pi: ExtensionAPI) {
  /**
   * The settings of the session. The first tool call reads them, because the
   * project trust decision is settled by then. A changed file needs a new
   * session.
   */
  let settings: Settings | undefined;
  const sessionSettings = (ctx: ExtensionContext): Settings => {
    if (settings === undefined) {
      const loaded = loadSettings(settingsFiles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted()));
      settings = loaded.settings;
      if (loaded.warning !== undefined) ctx.ui.notify(loaded.warning, "warning");
    }
    return settings;
  };

  /** The queue of the session. It keeps draining after the parent turn ends. */
  let queue: RunQueue | undefined;
  const sessionQueue = (ctx: ExtensionContext): RunQueue => {
    queue ??= createRunQueue(sessionSettings(ctx).maxConcurrency);
    return queue;
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: DESCRIPTION,
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent file to run" }),
      task: Type.String({ description: "The complete task text for the subagent" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = sessionSettings(ctx);
      const agent = withDefaultModel(
        loadAgent(params.agent, agentRoots(ctx.cwd, homedir(), current.agentDirs)),
        current.defaultModel,
      );
      const runsDir = join(
        ctx.sessionManager.getSessionDir(),
        "subagents",
        ctx.sessionManager.getSessionId(),
      );

      const run = prepareRun({
        agent,
        task: params.task,
        cwd: ctx.cwd,
        runsDir,
        env: process.env,
      });

      sessionQueue(ctx).add(run.id, () =>
        startRun(run).then(
          (outcome) => {
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: outcome.message,
                display: true,
                details: outcome.record,
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          },
          (error: Error) => {
            ctx.ui.notify(`Subagent run ${run.id} was lost: ${error.message}`, "error");
          },
        ),
      );

      // The record is the one source: the queue leaves it at "queued" when
      // every slot is taken, and startRun sets "running".
      const head =
        run.record.status === "queued"
          ? `Queued subagent "${agent.name}" as run ${run.id}. It starts when a slot is free.`
          : `Started subagent "${agent.name}" as run ${run.id}.`;

      return {
        content: [{ type: "text", text: `${head} Do not poll for the result.` }],
        details: { runId: run.id, dir: run.dir, status: run.record.status },
      };
    },
  });
}

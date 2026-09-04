import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createDispatcher, type Dispatcher } from "./src/dispatch.ts";

const DESCRIPTION = [
  "Delegate a task to a named subagent that runs in its own pi process.",
  "The tool returns a run id at once and the child works in the background.",
  "Do not poll for the result. The answer arrives on its own as a new turn.",
].join(" ");

export default function (pi: ExtensionAPI) {
  /**
   * The dispatcher of the session. The first tool call builds it, because the
   * project trust decision is settled by then, and it keeps the queue of the
   * session, which drains after the parent turn ends.
   */
  let dispatcher: Dispatcher | undefined;
  /**
   * The context of the tool call that runs now. pi gives a fresh one to every
   * call, so the host below reads this variable instead of holding the first
   * context of the session.
   */
  let current: ExtensionContext;
  const sessionDispatcher = (ctx: ExtensionContext): Dispatcher => {
    current = ctx;
    dispatcher ??= createDispatcher({
      cwd: () => current.cwd,
      home: homedir(),
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
      runsDir: () =>
        join(
          current.sessionManager.getSessionDir(),
          "subagents",
          current.sessionManager.getSessionId(),
        ),
      env: process.env,
      notify: (message, level) => current.ui.notify(message, level),
      showStatus: (line) => {
        current.ui.setWidget("subagents", line === undefined ? undefined : [line]);
      },
      sendResult: (message, record) => {
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: message,
            display: true,
            details: record,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
    });
    return dispatcher;
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
      const launch = sessionDispatcher(ctx).dispatch(params.agent, params.task);

      return {
        content: [{ type: "text", text: launch.text }],
        details: { runId: launch.id, dir: launch.dir, status: launch.status },
      };
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description: "Stop a running subagent by its run id. The child process is killed.",
    parameters: Type.Object({
      runId: Type.String({ description: "The run id that the subagent tool returned" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: sessionDispatcher(ctx).stop(params.runId) }],
        details: { runId: params.runId },
      };
    },
  });

  pi.registerCommand("subagent-stop", {
    description: "Stop a running subagent by its run id",
    handler: async (args, ctx) => {
      const runId = args.trim();
      const text =
        runId === ""
          ? "Give a run id. Example /subagent-stop a1b2c3d4."
          : sessionDispatcher(ctx).stop(runId);
      ctx.ui.notify(text, "info");
    },
  });

  // No child may outlive the session that made it.
  pi.on("session_shutdown", () => dispatcher?.stopAll());
}

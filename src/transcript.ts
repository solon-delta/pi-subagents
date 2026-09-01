import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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

const AssistantMessageEnd = Type.Object({
  type: Type.Literal("message_end"),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
  }),
});

function decode(line: string): Static<typeof AssistantMessageEnd> | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  return Value.Check(AssistantMessageEnd, event) ? event : undefined;
}

/** The text of the last assistant message in a child JSONL stream. */
export function assistantText(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    const event = decode(line);
    if (event === undefined) continue;
    text = event.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }
  return text;
}

/** The message that carries a finished run back into the parent conversation. */
export function resultMessage(record: RunRecord, text: string): string {
  const head = `Subagent "${record.agent}" (run ${record.id}) ${record.status}.`;
  return text === "" ? head : `${head}\n\n${text}`;
}

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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

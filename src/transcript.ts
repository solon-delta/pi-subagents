import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * The transcript of one run. The file `transcript.jsonl` in the run directory
 * holds every line the child printed, and this module alone writes that file.
 * The module keeps the text of the last assistant message and no other line.
 */
export interface TranscriptFile {
  /** One line of the child stream. It goes to the file and to the answer. */
  line(text: string): void;
  /** The text of the last assistant message, or the empty text. */
  answer(): string;
}

/** Truncate the transcript of a run and hand back the writer. */
export function createTranscript(dir: string): TranscriptFile {
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, "");
  let text = "";

  return {
    line(input) {
      // The file takes the line before the parser sees it, so a line that this
      // module cannot read is still on disk.
      // ponytail: appendFileSync opens, writes and closes the file for every
      // line. Hold one descriptor with openSync and add a close() when a run
      // prints enough lines for that to show.
      appendFileSync(path, `${input}\n`);

      const event = decode(input);
      if (event === undefined) return;
      text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
    },
    answer: () => text,
  };
}

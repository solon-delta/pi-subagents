import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const FILE_NAME = "transcript.jsonl";

const AssistantMessageEnd = Type.Object({
  type: Type.Literal("message_end"),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(
      Type.Object({
        type: Type.String(),
        text: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
      }),
    ),
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

/**
 * The transcript of a run as a reader sees it. Each assistant message gives its
 * text, and a tool call gives one line with the tool name, so a run that only
 * works with tools still shows what it does. Every other line drops out.
 */
export function transcriptLines(text: string): string[] {
  const lines: string[] = [];

  for (const raw of text.split("\n")) {
    const event = decode(raw);
    if (event === undefined) continue;

    const before = lines.length;
    for (const part of event.message.content) {
      if (part.type === "text") lines.push(...(part.text ?? "").split("\n"));
      if (part.type === "toolCall") lines.push(`[tool ${part.name ?? "?"}]`);
    }
    // One blank row between two messages, so the reader sees where one ends.
    if (lines.length > before) lines.push("");
  }

  // The blank row after the last message carries nothing.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Read the transcript of one run directory. A run with no file yet has no line. */
export function readTranscript(dir: string): string[] {
  try {
    return transcriptLines(readFileSync(join(dir, FILE_NAME), "utf8"));
  } catch {
    return [];
  }
}

/** Truncate the transcript of a run and hand back the writer. */
export function createTranscript(dir: string): TranscriptFile {
  const path = join(dir, FILE_NAME);
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

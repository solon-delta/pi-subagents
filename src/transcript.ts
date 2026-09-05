import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const FILE_NAME = "transcript.jsonl";

/** A message carries plain text in some turns and a list of parts in others. */
const PlainContent = Type.String();

const PartContent = Type.Array(
  Type.Object({
    type: Type.String(),
    text: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  }),
);

/**
 * One finished message of the child stream. pi emits this event for the task
 * that went in on stdin as well as for every answer, so the task text is in the
 * file and no other place has to keep it.
 */
const MessageEnd = Type.Object({
  type: Type.Literal("message_end"),
  message: Type.Object({
    role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
    content: Type.Union([PlainContent, PartContent]),
  }),
});

/** One message of the stream, after the two content shapes become one. */
interface Message {
  role: "assistant" | "user";
  parts: Static<typeof PartContent>;
}

/**
 * Read one line of the stream. The two content shapes are settled here, at the
 * boundary, so every reader below sees a list of parts and nothing else.
 */
function decode(line: string): Message | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!Value.Check(MessageEnd, event)) return undefined;

  const content = event.message.content;
  const parts = Value.Check(PlainContent, content) ? [{ type: "text", text: content }] : content;
  return { role: event.message.role, parts };
}

/** The text of one message, with no tool call and no thinking part. */
function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * The rows of one message. A tool call gives a row that names the tool, so a
 * run that only works with tools still shows what it does.
 */
function messageRows(message: Message): string[] {
  const rows: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") rows.push(...(part.text ?? "").split("\n"));
    if (part.type === "toolCall") rows.push(`[tool ${part.name ?? "?"}]`);
  }
  return rows;
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

/** The transcript of one run, as a reader sees it. */
export interface RunTranscript {
  /** The task of the run, from its first user message, or the empty text. */
  task: string;
  /** What the child said and did. An empty list means that it printed nothing. */
  rows: string[];
}

/**
 * Read one transcript stream. The first user message is the task, because the
 * launch sends the task and nothing else on stdin. Every later message gives
 * its rows. A line that this module cannot read drops out.
 */
export function parseTranscript(text: string): RunTranscript {
  let task = "";
  const rows: string[] = [];

  for (const raw of text.split("\n")) {
    const event = decode(raw);
    if (event === undefined) continue;

    if (event.role === "user") {
      // A steering message can arrive later. Only the first one is the task.
      if (task === "") task = messageText(event);
      continue;
    }

    const before = rows.length;
    rows.push(...messageRows(event));
    // One blank row between two messages, so the reader sees where one ends.
    if (rows.length > before) rows.push("");
  }

  // The blank row after the last message carries nothing.
  if (rows.at(-1) === "") rows.pop();
  return { task, rows };
}

/** Read the transcript of one run directory. A run with no file yet has no row. */
export function readTranscript(dir: string): RunTranscript {
  try {
    return parseTranscript(readFileSync(join(dir, FILE_NAME), "utf8"));
  } catch {
    return { task: "", rows: [] };
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
      // The answer of the run is what the child said. The task that pi echoes
      // back as a user message is not an answer.
      if (event === undefined || event.role !== "assistant") return;
      text = messageText(event);
    },
    answer: () => text,
  };
}

import type { RunStatus } from "./run-record.ts";

/**
 * The one line above the editor, or undefined when the line stays away. A run
 * that waits for a slot counts as work, because the user asked for it and it
 * still owes an answer. Every other run that ended counts as done.
 *
 * The line has no count of its own: the caller reads the status of every run of
 * the session and hands the list here.
 */
export function statusLine(statuses: RunStatus[]): string | undefined {
  const working = statuses.filter((status) => status === "queued" || status === "running").length;
  if (working === 0) return undefined;

  // The line always carries both numbers, and the words carry no plural, so it
  // is short at every count and fits one row of a narrow terminal.
  const done = statuses.length - working;
  return `subagents: ${working} working, ${done} done`;
}

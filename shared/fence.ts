/**
 * Data fences for quoting untrusted content inside prompts and messages.
 * A fence must be longer than any backtick run inside the fenced content,
 * or the content could close the fence early and escape as instructions.
 */

export function maxBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function dataFence(text: string): string {
  return "`".repeat(Math.max(4, maxBacktickRun(text) + 1));
}

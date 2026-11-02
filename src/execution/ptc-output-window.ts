/**
 * The merged stdout/stderr tail kept by the PTC runner and sampled by the agent. It mirrors the
 * harness `ShellOutputWindow` contract: at most `maxBytes` and `maxLines` at the end, with exact
 * counts for everything omitted before the retained tail.
 */

export type MergedChunk = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type MergedTake = {
  readonly text: string;
  readonly stream: "stdout" | "stderr";
  readonly skipped?: {
    readonly bytes: number;
    readonly newlines: number;
    readonly endsWithNewline: boolean;
  };
};

type Chunk = {
  text: string;
  bytes: number;
  newlines: number;
  stream: "stdout" | "stderr";
};

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 0x0a) count++;
  }
  return count;
}

export class MergedTailWindow {
  private chunks: Chunk[] = [];
  private bytes = 0;
  private lines = 0;
  private lastStream: "stdout" | "stderr" = "stdout";
  private skippedBytes = 0;
  private skippedLines = 0;
  private skippedEndsWithNewline = false;
  private hasSkipped = false;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
  ) {}

  get truncated(): boolean {
    return this.hasSkipped;
  }

  push(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) return;
    this.lastStream = stream;
    const chunk: Chunk = {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      newlines: countNewlines(text),
      stream,
    };
    this.chunks.push(chunk);
    this.bytes += chunk.bytes;
    this.lines += chunk.newlines;
    while (this.chunks.length > 1 && (this.bytes > this.maxBytes || this.lines > this.maxLines)) {
      const dropped = this.chunks.shift()!;
      this.recordSkipped(dropped.text);
      this.bytes -= dropped.bytes;
      this.lines -= dropped.newlines;
    }
    if (this.bytes <= this.maxBytes && this.lines <= this.maxLines) return;
    const first = this.chunks[0];
    if (first === undefined) return;
    let rest = first.text;
    let removed = "";
    if (this.lines > this.maxLines) {
      let cut = -1;
      for (let index = 0; index < this.lines - this.maxLines; index++) {
        cut = rest.indexOf("\n", cut + 1);
        if (cut === -1) break;
      }
      if (cut !== -1) {
        removed += rest.slice(0, cut + 1);
        rest = rest.slice(cut + 1);
      }
    }
    let restBytes = Buffer.byteLength(rest, "utf8");
    if (restBytes > this.maxBytes) {
      const encoded = Buffer.from(rest, "utf8");
      let cut = encoded.length - this.maxBytes;
      // Do not split a UTF-8 sequence.
      while (cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut++;
      removed += encoded.subarray(0, cut).toString("utf8");
      rest = encoded.subarray(cut).toString("utf8");
      restBytes = Buffer.byteLength(rest, "utf8");
    }
    this.recordSkipped(removed);
    this.bytes = restBytes;
    this.lines = countNewlines(rest);
    if (rest.length === 0) this.chunks.shift();
    else this.chunks[0] = { text: rest, bytes: restBytes, newlines: this.lines, stream: first.stream };
  }

  take(): MergedTake | undefined {
    if (this.chunks.length === 0 && !this.hasSkipped) return undefined;
    const text = this.chunks.map((chunk) => chunk.text).join("");
    const skipped = this.hasSkipped
      ? {
          bytes: this.skippedBytes,
          newlines: this.skippedLines,
          endsWithNewline: this.skippedEndsWithNewline,
        }
      : undefined;
    const stream = this.lastStream;
    this.chunks = [];
    this.bytes = 0;
    this.lines = 0;
    this.skippedBytes = 0;
    this.skippedLines = 0;
    this.skippedEndsWithNewline = false;
    this.hasSkipped = false;
    return { text, stream, ...(skipped === undefined ? {} : { skipped }) };
  }

  private recordSkipped(removed: string): void {
    if (removed.length === 0) return;
    this.hasSkipped = true;
    this.skippedBytes += Buffer.byteLength(removed, "utf8");
    this.skippedLines += countNewlines(removed);
    this.skippedEndsWithNewline = removed.endsWith("\n");
  }
}

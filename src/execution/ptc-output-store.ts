import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes, type Hash } from "node:crypto";
import { join } from "node:path";

export type StoredOutput = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly truncated: boolean;
};

/**
 * Streaming, content-addressed output blob in the job workspace. Bytes are written from the first
 * chunk; the file is renamed to its sha256 only after a successful flush, so a partially written
 * blob is never visible under its content address. When `maxBytes` is reached the rest is counted
 * and dropped, and `truncated` is reported.
 */
export class OutputSink {
  private readonly hash: Hash = createHash("sha256");
  private readonly tempPath: string;
  private readonly finalDirectory: string;
  private readonly fd: number;
  private size = 0;
  private truncated = false;
  private closed = false;

  constructor(
    directory: string,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("output maxBytes is invalid");
    this.finalDirectory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.tempPath = join(directory, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    this.fd = openSync(this.tempPath, "wx", 0o600);
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    let slice = chunk;
    if (this.size + chunk.length > this.maxBytes) {
      const remaining = Math.max(0, this.maxBytes - this.size);
      slice = chunk.subarray(0, remaining);
      this.truncated = true;
    }
    if (slice.length > 0) {
      writeSync(this.fd, slice);
      this.hash.update(slice);
      this.size += slice.length;
    }
  }

  finish(): StoredOutput {
    if (this.closed) throw new Error("output sink is closed");
    this.closed = true;
    try {
      fsyncSync(this.fd);
    } finally {
      closeSync(this.fd);
    }
    const sha256 = this.hash.digest("hex");
    const path = join(this.finalDirectory, sha256);
    if (existsSync(path)) {
      unlinkSync(this.tempPath);
    } else {
      renameSync(this.tempPath, path);
    }
    return { path, size: this.size, sha256, truncated: this.truncated };
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      // The descriptor is already unusable; removing the temp file is what matters.
    }
    try {
      unlinkSync(this.tempPath);
    } catch {
      // A concurrent cleanup may have removed it.
    }
  }
}

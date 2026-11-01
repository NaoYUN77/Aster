import { parseStrictJson } from "./strict-json.js";

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 600;
export const MAX_TRANSCRIPT_CHARS = 16_000;

export interface SttConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface AudioReference {
  readonly kind: "voice" | "audio";
  readonly fileId: string;
  readonly durationSeconds: number;
  readonly fileSize: number | null;
  /** Invalid metadata is persisted as a rejected input, never sent to STT. */
  readonly invalid?: true;
}

export interface AudioFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly filename: string;
}

export class SttError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SttError";
  }
}

export function validateAudio(audio: AudioReference): void {
  if (audio.invalid || !audio.fileId || audio.fileId.length > 1024
    || !Number.isSafeInteger(audio.durationSeconds) || audio.durationSeconds < 0
    || (audio.fileSize !== null && (!Number.isSafeInteger(audio.fileSize) || audio.fileSize <= 0))) {
    throw new SttError("STT_INVALID_AUDIO");
  }
  if (audio.durationSeconds > MAX_AUDIO_SECONDS || (audio.fileSize !== null && audio.fileSize > MAX_AUDIO_BYTES)) {
    throw new SttError("STT_AUDIO_TOO_LARGE");
  }
}

/** Telegram paths are opaque relative paths; never accept traversal, URL syntax or encoded separators. */
export function audioFilename(path: unknown): string {
  if (typeof path !== "string" || path.length > 1024
    || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)
    || path.split("/").some((part) => part === "." || part === "..")) {
    throw new SttError("STT_INVALID_FILE_PATH");
  }
  const extension = path.split(".").at(-1)!.toLowerCase();
  const normalized = extension === "oga" ? "ogg" : extension;
  if (!["ogg", "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "flac"].includes(normalized)) {
    throw new SttError("STT_UNSUPPORTED_FORMAT");
  }
  return `audio.${normalized}`;
}

/** Bound both advertised and streamed bytes; cancellation reaches the fetch and its body reader. */
export async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new SttError("STT_RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new SttError("STT_INVALID_RESPONSE");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SttError("STT_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function transcribeAudio(
  audio: AudioFile,
  config: SttConfig,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  if (audio.bytes.length === 0 || audio.bytes.length > MAX_AUDIO_BYTES) throw new SttError("STT_AUDIO_TOO_LARGE");
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const bounded = AbortSignal.any([signal, deadline]);
  try {
    bounded.throwIfAborted();
    const body = new FormData();
    body.append("file", new Blob([audio.bytes]), audio.filename);
    body.append("model", config.model);
    body.append("response_format", "json");
    const response = await (options.fetch ?? fetch)(config.apiUrl, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
      body,
      signal: bounded,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SttError(`STT_HTTP_${response.status}`);
    }
    const bytes = await readBoundedBody(response, 128 * 1024, bounded);
    let value: unknown;
    try {
      value = parseStrictJson(bytes, 128 * 1024);
    } catch {
      throw new SttError("STT_INVALID_RESPONSE");
    }
    if (!value || typeof value !== "object" || !("text" in value)
      || typeof value.text !== "string" || !value.text.isWellFormed() || value.text.includes("\0")) {
      throw new SttError("STT_INVALID_RESPONSE");
    }
    const text = value.text.trim();
    if (!text) throw new SttError("STT_EMPTY_TRANSCRIPT");
    if (text.length > MAX_TRANSCRIPT_CHARS) throw new SttError("STT_TRANSCRIPT_TOO_LARGE");
    return text;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw new SttError("STT_TIMEOUT");
    if (error instanceof SttError) throw error;
    throw new SttError("STT_NETWORK_ERROR");
  }
}

export function sttFailureReply(code: string): string {
  if (code === "STT_NOT_CONFIGURED") return "语音转写尚未配置，请先发送文字，或请维护者配置 STT。";
  if (code === "STT_AUDIO_TOO_LARGE") return "音频超过限制（20 MiB / 10 分钟），请拆分后重发或发送文字。";
  if (code === "STT_EMPTY_TRANSCRIPT") return "未识别到有效文字，请重新录音或发送文字。";
  if (code === "STT_TRANSCRIPT_TOO_LARGE") return "转写文字超过 16,000 字符，请拆分音频或发送文字。";
  if (code === "STT_UNSUPPORTED_FORMAT") return "暂不支持此音频格式，请发送 Telegram 语音或 MP3、M4A、WAV、OGG 等音频。";
  if (code === "STT_UNCERTAIN") return "语音转写被中断，服务端可能已处理或计费，未自动重试，也未交给 agent。请发送文字；重新发送音频会创建新请求，可能再次计费。";
  return `语音转写失败（${code}），未交给 agent。请发送文字；重新发送音频会创建新请求，可能再次计费。`;
}

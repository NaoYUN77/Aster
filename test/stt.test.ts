import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { readConfig } from "../src/config.js";
import {
  audioFilename, MAX_AUDIO_BYTES, readBoundedBody, SttError, transcribeAudio, validateAudio,
} from "../src/stt.js";

const config = { apiUrl: "https://stt.example/v1/audio/transcriptions", apiKey: "synthetic-key", model: "whisper-1" };
const audio = { bytes: new Uint8Array([1, 2, 3]), filename: "audio.ogg" };
const signal = new AbortController().signal;
const base = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "key" };
const enabled = { STT_API_URL: config.apiUrl, STT_API_KEY: "__vault_STT_API_KEY__", STT_MODEL: config.model };
const hasCode = (code: string) => (error: unknown) => error instanceof SttError && error.code === code;

test("STT is optional, independent of chat provider, and rejects partial/unsafe configuration without revealing keys", () => {
  assert.equal(readConfig(base).stt, undefined);
  assert.equal(readConfig({ ...base, STT_MODEL: " " }).stt, undefined);
  assert.deepEqual(readConfig({ ...base, ...enabled }).stt, { ...config, apiKey: enabled.STT_API_KEY });
  for (const key of Object.keys(enabled)) {
    assert.throws(() => readConfig({ ...base, ...enabled, [key]: "" }), new RegExp(key));
  }
  for (const apiUrl of ["bad", "http://stt.example/transcribe", "https://user:synthetic@stt.example/", "https://stt.example/?key=secret", "https://stt.example/#secret"]) {
    assert.throws(() => readConfig({ ...base, ...enabled, STT_API_URL: apiUrl }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /STT_API_URL/);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.throws(() => readConfig({ ...base, ...enabled, STT_API_KEY: "__vault_STT_API_KEY_" }), /malformed vault placeholder/);
  assert.throws(() => readConfig({ ...base, ...enabled, STT_API_KEY: "key\r\nheader" }), /STT_API_KEY/);
  assert.throws(() => readConfig({ ...base, ...enabled, STT_MODEL: "x\0y" }), /STT_MODEL/);
});

test("Whisper multipart sends exact bytes, bearer, model and json response format without following redirects", async () => {
  let calls = 0;
  const text = await transcribeAudio(audio, config, signal, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, config.apiUrl);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-key");
      assert.equal(new Headers(init?.headers).get("content-type"), null, "fetch supplies the multipart boundary");
      const body = init!.body as FormData;
      const file = body.get("file") as File;
      assert.equal(file.name, "audio.ogg");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio.bytes);
      assert.equal(body.get("model"), "whisper-1");
      assert.equal(body.get("response_format"), "json");
      return Response.json({ text: "  你好 Telegram  " });
    },
  });
  assert.equal(text, "你好 Telegram");
  assert.equal(calls, 1);
});

test("STT rejects HTTP, redirects, malformed/empty transcripts and oversized bodies, without retry or provider error leaks", async () => {
  const cases: [() => Response, string][] = [
    [() => new Response("secret response", { status: 401 }), "STT_HTTP_401"],
    [() => new Response("quota secret", { status: 429 }), "STT_HTTP_429"],
    [() => new Response(null, { status: 307, headers: { location: "https://other.example/" } }), "STT_HTTP_307"],
    [() => new Response("bad json"), "STT_INVALID_RESPONSE"],
    [() => new Response('{"text":"one","text":"two"}'), "STT_INVALID_RESPONSE"],
    [() => Response.json({ text: 42 }), "STT_INVALID_RESPONSE"],
    [() => Response.json({ text: " \n " }), "STT_EMPTY_TRANSCRIPT"],
    [() => Response.json({ text: "\ud800" }), "STT_INVALID_RESPONSE"],
    [() => Response.json({ text: "x".repeat(16_001) }), "STT_TRANSCRIPT_TOO_LARGE"],
    [() => new Response("x".repeat(128 * 1024 + 1)), "STT_RESPONSE_TOO_LARGE"],
    [() => new Response("{}", { headers: { "content-length": String(128 * 1024 + 1) } }), "STT_RESPONSE_TOO_LARGE"],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    await assert.rejects(transcribeAudio(audio, config, signal, {
      fetch: async () => { calls++; return response(); },
    }), hasCode(code));
    assert.equal(calls, 1);
  }
  await assert.rejects(transcribeAudio(audio, config, signal, {
    fetch: async () => { throw new Error("secret endpoint"); },
  }), hasCode("STT_NETWORK_ERROR"));
});

test("audio limits reject invalid metadata and formats; oga maps to ogg with a host-chosen filename", () => {
  const reference = { kind: "voice" as const, fileId: "file-id", durationSeconds: 600, fileSize: MAX_AUDIO_BYTES };
  validateAudio(reference);
  validateAudio({ ...reference, fileSize: null });
  for (const change of [{ durationSeconds: -1 }, { durationSeconds: 1.5 }, { fileSize: 0 }, { invalid: true as const }]) {
    assert.throws(() => validateAudio({ ...reference, ...change }), hasCode("STT_INVALID_AUDIO"));
  }
  for (const change of [{ durationSeconds: 601 }, { fileSize: MAX_AUDIO_BYTES + 1 }]) {
    assert.throws(() => validateAudio({ ...reference, ...change }), hasCode("STT_AUDIO_TOO_LARGE"));
  }
  assert.equal(audioFilename("voice/file_1.oga"), "audio.ogg");
  assert.equal(audioFilename("music/file_1.MP3"), "audio.mp3");
  for (const path of [undefined, "/etc/passwd.ogg", "../file.ogg", "voice/../file.ogg", "https://evil/file.ogg", "voice/%2e%2e.ogg", "voice/file.ogg?key=x"]) {
    assert.throws(() => audioFilename(path), hasCode("STT_INVALID_FILE_PATH"));
  }
  assert.throws(() => audioFilename("audio/file.exe"), hasCode("STT_UNSUPPORTED_FORMAT"));
});

test("bounded body reader cancels oversized streams and aborts a stalled response body", async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readBoundedBody(oversized, 10, signal), hasCode("STT_RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
  const stop = new AbortController();
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  cancelled = false;
  const reading = readBoundedBody(stalled, 10, stop.signal);
  stop.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("STT deadline and parent cancellation terminate actual HTTP response I/O", async () => {
  const sockets = new Set<import("node:net").Socket>();
  let cancelRequest: AbortController | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"text":"');
    cancelRequest?.abort();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const localFetch: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/transcribe`, init);
  try {
    await assert.rejects(transcribeAudio(audio, config, signal, { fetch: localFetch, timeoutMs: 100 }), hasCode("STT_TIMEOUT"));
    cancelRequest = new AbortController();
    const pending = transcribeAudio(audio, config, cancelRequest.signal, { fetch: localFetch });
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOptionalEnvSecrets } from "../src/secret-env.js";

const ACCESS_ID = "access-client-id";
const ACCESS_SECRET = "access-client-secret";
const EXA_VALUE = "exa-broker-value-000000000000";
const DEEPSEEK_VALUE = "deepseek-broker-value-0000000";

type Call = { readonly url: string; readonly headers: Headers };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Answers by secret name; a value of `undefined` means 404 with the broker envelope. */
function responder(calls: Call[], answers: Record<string, string | undefined>): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const name = url.slice(url.lastIndexOf("/") + 1);
    const value = answers[name];
    if (value === undefined) {
      return json({ error: { code: "SECRET_NOT_CONFIGURED", message: "secret is not configured" } }, 404);
    }
    return json({ name, value });
  }) as typeof fetch;
}

async function tokenFile(dir: string): Promise<string> {
  const file = join(dir, "service-token");
  await writeFile(file, `${ACCESS_ID}\n${ACCESS_SECRET}\n`, { mode: 0o600 });
  return file;
}

function cfEnv(file: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ASTER_SECRET_BACKEND: "cf",
    ASTER_SECRET_BROKER_URL: "https://broker.example",
    ASTER_CF_ACCESS_TOKEN_FILE: file,
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aster-secret-env-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a non-cf backend returns the env untouched and makes no request", async () => {
  const calls: Call[] = [];
  const env = { ASTER_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
  const logs: string[] = [];
  const result = await resolveOptionalEnvSecrets(env, {
    fetch: responder(calls, {}),
    log: (line) => logs.push(line),
  });
  assert.equal(result, env);
  assert.equal(calls.length, 0);
  assert.equal(env.EXA_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
  assert.deepEqual(logs, []);
});

test("cf mode injects both keys with the Access service token and logs no value", async () => {
  await withDir(async (dir) => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    const result = await resolveOptionalEnvSecrets(env, {
      fetch: responder(calls, { exa_api_key: EXA_VALUE, deepseek_web_api_key: DEEPSEEK_VALUE }),
      log: (line) => logs.push(line),
    });
    assert.equal(result, env);
    assert.equal(env.EXA_API_KEY, EXA_VALUE);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, DEEPSEEK_VALUE);
    assert.deepEqual(
      calls.map((call) => call.url).sort(),
      ["https://broker.example/v1/secrets/deepseek_web_api_key", "https://broker.example/v1/secrets/exa_api_key"],
    );
    for (const call of calls) {
      assert.equal(call.headers.get("CF-Access-Client-Id"), ACCESS_ID);
      assert.equal(call.headers.get("CF-Access-Client-Secret"), ACCESS_SECRET);
    }
    for (const line of logs) {
      assert.equal(line.includes(EXA_VALUE), false);
      assert.equal(line.includes(DEEPSEEK_VALUE), false);
    }
  });
});

test("a 404 leaves that key unset, still resolves the other, and names only the code", async () => {
  await withDir(async (dir) => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    await resolveOptionalEnvSecrets(env, {
      fetch: responder(calls, { exa_api_key: EXA_VALUE }),
      log: (line) => logs.push(line),
    });
    assert.equal(env.EXA_API_KEY, EXA_VALUE);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
    assert.ok(logs.some((line) => line.includes("deepseek_web_api_key") && line.includes("SECRET_NOT_CONFIGURED")));
    for (const line of logs) assert.equal(line.includes(DEEPSEEK_VALUE), false);
  });
});

test("a transport failure never throws and leaves both keys unset", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await resolveOptionalEnvSecrets(env, { fetch: failing, log: (line) => logs.push(line) });
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
    assert.equal(logs.filter((line) => line.includes("SECRETS_UNAVAILABLE")).length, 2);
  });
});

test("a 403 is reported as ACCESS_DENIED and is not an error", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    const denied = (async () => json({ error: { code: "FORBIDDEN" } }, 403)) as typeof fetch;
    const result = await resolveOptionalEnvSecrets(env, { fetch: denied, log: (line) => logs.push(line) });
    assert.equal(result, env);
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(logs.filter((line) => line.includes("ACCESS_DENIED")).length, 2);
  });
});

test("an existing environment value is never overwritten, and its secret is not fetched", async () => {
  await withDir(async (dir) => {
    const calls: Call[] = [];
    const env = cfEnv(await tokenFile(dir), { EXA_API_KEY: "from-env" });
    await resolveOptionalEnvSecrets(env, {
      fetch: responder(calls, { exa_api_key: EXA_VALUE, deepseek_web_api_key: DEEPSEEK_VALUE }),
      log: () => {},
    });
    assert.equal(env.EXA_API_KEY, "from-env");
    assert.equal(env.DEEPSEEK_WEB_API_KEY, DEEPSEEK_VALUE);
    assert.deepEqual(calls.map((call) => call.url), ["https://broker.example/v1/secrets/deepseek_web_api_key"]);
  });
});

test("incomplete broker settings leave the keys unset without a request", async () => {
  const logs: string[] = [];
  const noUrl = { ASTER_SECRET_BACKEND: "cf", ASTER_CF_ACCESS_TOKEN_FILE: "/run/secrets/token" } as NodeJS.ProcessEnv;
  const noToken = { ASTER_SECRET_BACKEND: "cf", ASTER_SECRET_BROKER_URL: "https://broker.example" } as NodeJS.ProcessEnv;
  const calls: Call[] = [];
  for (const env of [noUrl, noToken]) {
    await resolveOptionalEnvSecrets(env, { fetch: responder(calls, {}), log: (line) => logs.push(line) });
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
  }
  assert.equal(calls.length, 0);
  assert.equal(logs.filter((line) => line.includes("SECRETS_UNAVAILABLE")).length, 2);
});

test("a hung broker is abandoned after the timeout and startup continues", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    const hung = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    const started = Date.now();
    await resolveOptionalEnvSecrets(env, { fetch: hung, timeoutMs: 50, log: (line) => logs.push(line) });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
    assert.equal(logs.filter((line) => line.includes("SECRETS_UNAVAILABLE")).length, 2);
  });
});

test("a timeout above the cap is clamped, so an unreachable broker costs at most 3s at startup", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    // Ignores the abort signal for the first 10s: only the clamped timeout can end this.
    const hung = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("still hung after 10s")), 10_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;
    const started = Date.now();
    const result = await resolveOptionalEnvSecrets(env, {
      fetch: hung,
      timeoutMs: 60_000,
      log: (line) => logs.push(line),
    });
    const elapsed = Date.now() - started;
    assert.equal(result, env);
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
    assert.equal(logs.filter((line) => line.includes("SECRETS_UNAVAILABLE")).length, 2);
    // Proves the 60s request was clamped to the 3s ceiling and that startup was never held longer.
    assert.ok(elapsed >= 2_500, `resolved in ${elapsed}ms, expected the 3s clamp to apply`);
    assert.ok(elapsed < 6_000, `resolved in ${elapsed}ms, startup was held too long`);
  });
});

test("a malformed body or value is rejected without leaking it", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const env = cfEnv(await tokenFile(dir));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("exa_api_key")) return new Response("not json", { status: 200 });
      if (url.endsWith("deepseek_web_api_key")) {
        return json({ name: "deepseek_web_api_key", value: "__vault_something_else__" });
      }
      return json({}, 404);
    }) as typeof fetch;
    await resolveOptionalEnvSecrets(env, { fetch: fetchImpl, log: (line) => logs.push(line) });
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_WEB_API_KEY, undefined);
    assert.ok(logs.some((line) => line.includes("exa_api_key") && line.includes("INVALID_RESPONSE")));
    assert.ok(logs.some((line) => line.includes("deepseek_web_api_key") && line.includes("INVALID_VALUE")));
    for (const line of logs) assert.equal(line.includes("__vault_something_else__"), false);
  });
});

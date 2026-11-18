import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerClient, type BrokerClientOptions } from "../src/connectors/broker-client.js";
import { CfSecretProvider } from "../src/connectors/secrets.js";

const BASE = "https://broker.example.test";

function fakeBroker(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch, overrides: Partial<BrokerClientOptions> = {}): BrokerClient {
  return new BrokerClient({
    baseUrl: BASE,
    accessClientId: "access-client-id",
    accessClientSecret: "access-client-secret",
    timeoutMs: 5_000,
    fetch: fetchImpl,
    ...overrides,
  });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

test("reads whitelisted secrets from the broker and caches them for five minutes", async () => {
  let now = 1_000_000;
  const { fetchImpl, calls } = fakeBroker((url) => {
    if (url === `${BASE}/v1/secrets/github_client_id`) return json({ name: "github_client_id", value: "client-id-value" });
    if (url === `${BASE}/v1/secrets/credential_master_key`) return json({ name: "credential_master_key", value: "11".repeat(32) });
    return json({ error: { code: "SECRET_NOT_ALLOWED", message: "no" } }, 404);
  });
  const provider = new CfSecretProvider({ client: client(fetchImpl), now: () => now });

  assert.equal(await provider.readText("github_client_id"), "client-id-value");
  assert.equal(await provider.readText("github_client_id"), "client-id-value");
  assert.equal(calls.length, 1, "the second read is served from memory");

  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("cf-access-client-id"), "access-client-id");
  assert.equal(headers.get("cf-access-client-secret"), "access-client-secret");
  assert.equal(headers.get("accept"), "application/json");

  now += 5 * 60 * 1000 - 1;
  assert.equal(await provider.readText("github_client_id"), "client-id-value");
  assert.equal(calls.length, 1, "still inside the five-minute window");

  now += 2;
  assert.equal(await provider.readText("github_client_id"), "client-id-value");
  assert.equal(calls.length, 2, "an expired cache entry is refetched");

  assert.deepEqual(await provider.masterKey(), Buffer.from("11".repeat(32), "hex"));
});

test("the Access token file takes precedence over the two environment values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-cf-token-"));
  try {
    const tokenFile = join(directory, "access-token");
    await writeFile(tokenFile, "file-client-id\nfile-client-secret\n", { mode: 0o400 });
    const { fetchImpl, calls } = fakeBroker(() => json({ name: "exa_api_key", value: "exa-value" }));
    const provider = new CfSecretProvider({
      client: client(fetchImpl, {
        accessTokenFile: tokenFile,
        accessClientId: "env-client-id",
        accessClientSecret: "env-client-secret",
      }),
    });
    assert.equal(await provider.readText("exa_api_key"), "exa-value");
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get("cf-access-client-id"), "file-client-id");
    assert.equal(headers.get("cf-access-client-secret"), "file-client-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed or missing Access token file fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-cf-token-bad-"));
  try {
    const { fetchImpl } = fakeBroker(() => json({ name: "exa_api_key", value: "value" }));
    const tooMany = join(directory, "three-lines");
    await writeFile(tooMany, "a\nb\nc\n");
    await assert.rejects(
      new CfSecretProvider({ client: client(fetchImpl, { accessTokenFile: tooMany }) }).read("exa_api_key"),
      (error) => codeOf(error) === "SECRETS_UNAVAILABLE",
    );
    await assert.rejects(
      new CfSecretProvider({
        client: new BrokerClient({ baseUrl: BASE, timeoutMs: 5_000, fetch: fetchImpl }),
      }).read("exa_api_key"),
      (error) => {
        assert.equal(codeOf(error), "SECRETS_UNAVAILABLE");
        assert.equal((error as Error).message.includes("access-client-id"), false);
        return true;
      },
    );
    await assert.rejects(
      new CfSecretProvider({ client: client(fetchImpl, { accessTokenFile: join(directory, "missing") }) }).read("exa_api_key"),
      (error) => codeOf(error) === "SECRETS_UNAVAILABLE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every broker failure is SECRETS_UNAVAILABLE and never reveals the value", async () => {
  const secretValue = "do-not-leak-this-value";
  const cases: ((url: string, init: RequestInit) => Response | Promise<Response>)[] = [
    () => json({ error: { code: "BROKER_UNAUTHORIZED", message: "no" } }, 403),
    () => new Response(`upstream ${secretValue}`, { status: 500 }),
    () => new Response("not json", { status: 200 }),
    () => json({ name: "exa_api_key", value: 42 }),
    () => json({ name: "other_name", value: secretValue }),
    () => json({ value: secretValue }),
    () => {
      throw Object.assign(new Error(`timeout ${secretValue}`), { name: "TimeoutError" });
    },
  ];
  for (const handler of cases) {
    const { fetchImpl } = fakeBroker(handler);
    const provider = new CfSecretProvider({ client: client(fetchImpl) });
    await assert.rejects(provider.read("exa_api_key"), (error) => {
      assert.equal(codeOf(error), "SECRETS_UNAVAILABLE");
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      assert.equal(text.includes(secretValue), false, "the value never reaches an error");
      return true;
    });
  }
});

test("an empty secret and an invalid master key are named errors, not fallbacks", async () => {
  const { fetchImpl } = fakeBroker((url) => url.endsWith("credential_master_key")
    ? json({ name: "credential_master_key", value: "too-short" })
    : json({ name: "exa_api_key", value: "" }));
  const provider = new CfSecretProvider({ client: client(fetchImpl) });
  await assert.rejects(provider.read("exa_api_key"), (error) => codeOf(error) === "CONNECTOR_SECRET_MISSING");
  await assert.rejects(provider.masterKey(), (error) => codeOf(error) === "CONNECTOR_MASTER_KEY_INVALID");
});

test("secret names are validated before any request is sent", async () => {
  const { fetchImpl, calls } = fakeBroker(() => json({ name: "exa_api_key", value: "value" }));
  const provider = new CfSecretProvider({ client: client(fetchImpl) });
  await assert.rejects(provider.read("../exa_api_key"), (error) => codeOf(error) === "CONNECTOR_SECRET_MISSING");
  assert.equal(calls.length, 0);
});

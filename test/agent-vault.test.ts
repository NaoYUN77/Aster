import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";
import { readAgentVaultEnvironment, vaultPlaceholder } from "../src/agent-vault.js";
import { readConfig } from "../src/config.js";
import { validateMcpConfig } from "../src/mcp-config.js";
import { openMcpConnection } from "../src/mcp.js";

const enabled = { AGENT_VAULT_ENABLED: "1" };
const http = { name: "api", transport: "http", url: "https://example.com/mcp" };
const stdio = { name: "cli", transport: "stdio", command: "node" };

test("vault references never resolve to process secrets and require an enabled broker", () => {
  const raw = { servers: [{ ...stdio, env: { API_TOKEN: "${vault:API_TOKEN}", USERNAME: "${vault:USERNAME}" } }] };
  const read = validateMcpConfig(raw, { ...enabled, API_TOKEN: "must-not-be-read" });
  assert.deepEqual(read.warnings, []);
  const server = read.config!.servers[0]!;
  assert.equal(server.transport, "stdio");
  if (server.transport === "stdio") assert.deepEqual(server.env, { API_TOKEN: "__vault_API_TOKEN__", USERNAME: "__vault_USERNAME__" });
  assert.equal(validateMcpConfig(raw, {}).config?.servers.length, 0);
  assert.throws(() => vaultPlaceholder("bad-key"));
  for (const value of ["${vault:bad-key}", "${vault:UNCLOSED"]) {
    assert.equal(validateMcpConfig({ servers: [{ ...stdio, env: { API_TOKEN: value } }] }, enabled).config?.servers.length, 0);
  }
});

test("brokered MCP rejects credential and proxy bypass configuration but keeps external OAuth", () => {
  const cases = [
    { ...stdio, inheritEnv: true },
    { ...stdio, env: { PASSWORD: "actual-secret" } },
    { ...stdio, env: { API_KEY: "${KEY}" } },
    { ...stdio, env: { HTTPS_PROXY: "http://other" } },
    { ...stdio, env: { no_proxy: "*" } },
    { ...stdio, env: { NODE_OPTIONS: "--no-use-env-proxy" } },
    { ...http, url: "https://example.com/mcp?token=secret" },
    { ...http, headers: { Authorization: "Bearer actual-secret" } },
    { ...http, headers: { "X-Custom-Credential": "actual-secret" } },
  ];
  for (const server of cases) {
    const read = validateMcpConfig({ servers: [server] }, { ...enabled, KEY: "actual-secret" });
    assert.deepEqual(read.config?.servers, []);
    assert.equal(read.warnings.length, 1);
    assert.doesNotMatch(read.warnings[0]!, /actual-secret/);
  }
  const oauth = validateMcpConfig({ servers: [{ ...http, auth: { type: "oauth" }, headers: { "X-Client": "personal-agent" } }] }, enabled);
  assert.deepEqual(oauth.warnings, []);
  const bearer = validateMcpConfig({ servers: [{ ...http, headers: { Authorization: "Bearer ${vault:API_TOKEN}" } }] }, enabled);
  assert.deepEqual(bearer.warnings, []);
});

test("proxy configuration fails closed without printing proxy authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-vault-"));
  try {
    const ca = join(directory, "ca.pem");
    await writeFile(ca, rootCertificates[0]!);
    const proxy = "http://sensitive-token:vault@127.0.0.1:14322";
    const env = { ...enabled, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca };
    assert.equal(readAgentVaultEnvironment(env)?.CURL_CA_BUNDLE, ca);
    assert.equal(readAgentVaultEnvironment({}), undefined);
    for (const patch of [
      { HTTPS_PROXY: "not a URL" }, { HTTP_PROXY: "http://other:14322" },
      { NO_PROXY: "*" }, { NO_PROXY: "example.com" }, { no_proxy: "*" },
      { NODE_USE_ENV_PROXY: "0" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      { NODE_EXTRA_CA_CERTS: "relative.pem" }, { CURL_CA_BUNDLE: "/other.pem" },
    ]) {
      assert.throws(() => readAgentVaultEnvironment({ ...env, ...patch }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /sensitive-token/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("brokered config keeps entry credentials in Infisical and reads the owner ID from a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-vault-config-"));
  try {
    const ca = join(directory, "ca.pem");
    const owner = join(directory, "owner-id");
    await writeFile(ca, rootCertificates[0]!);
    await writeFile(owner, "42\n");
    const proxy = "http://test-token:test-vault@127.0.0.1:14322";
    const base = {
      AGENT_VAULT_ENABLED: "1", HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: ca, TELEGRAM_OWNER_ID_FILE: owner, MODEL_PROVIDER: "openai", MODEL_ID: "m",
    };
    const placeholders = { TELEGRAM_BOT_TOKEN: "__vault_TELEGRAM_BOT_TOKEN__", OPENAI_API_KEY: "sk-__vault_OPENAI_API_KEY__" };
    assert.throws(
      () => readConfig({ ...base, ...placeholders, TELEGRAM_BOT_TOKEN: "real-token" }),
      /TELEGRAM_BOT_TOKEN must be an Agent Vault placeholder/,
    );
    assert.throws(
      () => readConfig({ ...base, ...placeholders, OPENAI_API_KEY: "sk-real-key" }),
      /OPENAI_API_KEY must be an Agent Vault placeholder/,
    );
    assert.throws(
      () => readConfig({ ...base, ...placeholders, ANTHROPIC_API_KEY: "sk-real-leftover" }),
      /ANTHROPIC_API_KEY must be an Agent Vault placeholder/,
    );
    assert.throws(
      () => readConfig({ ...base, ...placeholders, TELEGRAM_OWNER_ID: "42", TELEGRAM_OWNER_ID_FILE: undefined }),
      /requires TELEGRAM_OWNER_ID_FILE/,
    );
    const config = readConfig({ ...base, ...placeholders });
    assert.equal(config.token, "__vault_TELEGRAM_BOT_TOKEN__");
    assert.equal(config.ownerId, "42");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdio MCP inherits proxy and CA settings without host or Infisical secrets", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-vault-child-"));
  try {
    const ca = join(directory, "ca.pem");
    await writeFile(ca, rootCertificates[0]!);
    const proxy = "http://test-token:test-vault@127.0.0.1:14322";
    const env = {
      ...process.env, ...enabled, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca,
      NO_PROXY: "localhost,127.0.0.1", SECRET_TOKEN: "hidden", INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "hidden",
    };
    for (const key of ["http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy"]) delete env[key as keyof typeof env];
    const connection = await openMcpConnection({
      name: "fixture", transport: "stdio", command: process.execPath,
      args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")], env: { API_TOKEN: "__vault_API_TOKEN__" },
      inheritEnv: false, timeoutMs: 5_000, connectTimeoutMs: 5_000,
    }, { dataDir: directory, env });
    try {
      for (const [key, expected] of Object.entries({
        HTTPS_PROXY: proxy, NODE_EXTRA_CA_CERTS: ca, CURL_CA_BUNDLE: ca, API_TOKEN: "__vault_API_TOKEN__",
        SECRET_TOKEN: "", INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "",
      })) {
        const result = await connection.callTool("env", { key }, { timeoutMs: 5_000 });
        assert.deepEqual(result.content, [{ type: "text", text: expected }]);
      }
    } finally {
      await connection.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

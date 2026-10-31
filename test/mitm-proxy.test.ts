import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ConfigurationError, configureEnvProxy, isVaultPlaceholder, readConfig } from "../src/config.js";
import { PROVIDERS } from "../src/providers.js";

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

// Records CONNECT targets and refuses them, so the child process gets a fast failure and no network access.
async function withConnectLogger(run: (proxyUrl: string, targets: string[]) => Promise<void>) {
  const targets: string[] = [];
  const server = createServer((_request, response) => response.writeHead(502).end());
  server.on("connect", (request, socket) => {
    targets.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  const port = await listen(server);
  try {
    await run(`http://127.0.0.1:${port}`, targets);
  } finally {
    server.close();
  }
}

function runNode(script: string, env: Record<string, string>) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(https?|no)_proxy$/i.test(key) && key !== "NODE_USE_ENV_PROXY"),
  );
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...inherited, ...env },
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

const fetchProbe = (url: string) => `
  try { await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) }); } catch {}
`;

test("readConfig accepts __vault_<NAME>__ placeholders and rejects malformed placeholders or insecure TLS", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "__vault_TELEGRAM_BOT_TOKEN__",
    TELEGRAM_OWNER_ID: "42",
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-chat",
    DEEPSEEK_API_KEY: "__vault_DEEPSEEK_API_KEY__",
    DEEPSEEK_WEB_API_KEY: "__vault_DEEPSEEK_WEB_API_KEY__",
    HTTPS_PROXY: "http://aster-mitm:14322",
    HTTP_PROXY: "http://aster-mitm:14322",
  };
  const cfg = readConfig(base);
  assert.equal(cfg.token, "__vault_TELEGRAM_BOT_TOKEN__");
  assert.equal(cfg.webApiKey, "__vault_DEEPSEEK_WEB_API_KEY__");
  assert.equal(isVaultPlaceholder("__vault_DEEPSEEK_API_KEY__"), true);
  assert.equal(isVaultPlaceholder("__vault_bad-name__"), false);

  assert.throws(
    () => readConfig({ ...base, DEEPSEEK_API_KEY: "__vault_DEEPSEEK_API_KEY" }),
    ConfigurationError,
  );
  assert.throws(
    () => readConfig({ ...base, TELEGRAM_BOT_TOKEN: "__vault_lowercase__" }),
    ConfigurationError,
  );
  assert.throws(
    () => readConfig({ ...base, DEEPSEEK_WEB_API_KEY: "__vault_bad__" }),
    ConfigurationError,
  );
  assert.throws(
    () => readConfig({ ...base, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    /NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed/,
  );
  assert.throws(
    () => configureEnvProxy({ HTTPS_PROXY: "socks5://aster-mitm:14322" }),
    /HTTPS_PROXY must use http: or https:/,
  );
});

test("LLM fetch, web_search/web_fetch, and TelegramClient tunnel through HTTPS_PROXY and trust NODE_EXTRA_CA_CERTS", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-mitm-tls-"));
  const sockets = new Set<Duplex>();
  const tunnels: string[] = [];
  const seenRequests: Array<{ method: string; url: string; auth?: string }> = [];
  const ca = join(directory, "mitmproxy-ca.pem");
  const key = join(directory, "mitmproxy-key.pem");
  let proxy: ReturnType<typeof createServer> | undefined;
  let upstream: ReturnType<typeof createHttpsServer> | undefined;
  try {
    const opensslConfig = join(directory, "openssl.cnf");
    await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
    await exec(
      "openssl",
      [
        "req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", ca, "-days", "1", "-subj", "/CN=aster-mitm-test",
        "-addext", "subjectAltName=DNS:api.deepseek.com,DNS:api.telegram.org",
      ],
      { timeout: 10_000 },
    );

    upstream = createHttpsServer({ key: await readFile(key), cert: await readFile(ca) }, (req, res) => {
      seenRequests.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/chat/completions") {
        res.end(JSON.stringify({ id: "cmpl-1", choices: [] }));
      } else if (req.url === "/v1/tools/search") {
        res.end(
          JSON.stringify({
            results: [
              {
                title: "Aster Doc",
                url: "https://example.org/a",
                snippet: "ok",
                summary: "summary",
                content: "content",
                site_name: "example.org",
                site_icon: null,
                date: null,
                rerank_score: 1,
                authority: 1,
              },
            ],
          }),
        );
      } else if (req.url === "/v1/tools/fetch") {
        res.end(JSON.stringify({ url: "https://example.org/a", title: "Aster Doc", content: "# Hello" }));
      } else if (req.url?.endsWith("/getMe")) {
        res.end(JSON.stringify({ ok: true, result: { id: 777000, is_bot: true, first_name: "Aster" } }));
      } else if (req.url?.endsWith("/getWebhookInfo")) {
        res.end(JSON.stringify({ ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } }));
      } else {
        res.writeHead(404).end();
      }
    });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const upstreamPort = await listen(upstream);

    proxy = createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url ?? "");
      const remote = connect(upstreamPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      sockets.add(remote);
      remote.on("close", () => sockets.delete(remote));
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      client.on("close", () => remote.destroy());
    });
    const proxyPort = await listen(proxy);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1,aster-mitm,aster-openbao",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: ca,
    };
    for (const name of ["http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
      delete env[name];
    }

    const probeScript = `
      import assert from "node:assert/strict";
      import { configureEnvProxy } from "./src/config.ts";
      import { TelegramClient } from "./src/telegram.ts";
      import { searchWeb } from "./src/web-search.ts";
      import { fetchWeb } from "./src/web-fetch.ts";

      configureEnvProxy();

      const llmRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer __vault_DEEPSEEK_API_KEY__", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
      });
      assert.equal(llmRes.status, 200);

      const searchOut = await searchWeb({ query: "aster" }, { apiKey: "__vault_DEEPSEEK_WEB_API_KEY__" });
      assert.equal(searchOut.ok, true);

      const fetchOut = await fetchWeb({ url: "https://example.org/a" }, { apiKey: "__vault_DEEPSEEK_WEB_API_KEY__" });
      assert.equal(fetchOut.ok, true);

      const tg = new TelegramClient("__vault_TELEGRAM_BOT_TOKEN__");
      const botId = await tg.identity(AbortSignal.timeout(10_000));
      assert.equal(botId, "777000");
    `;

    await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probeScript], {
      cwd: root,
      env,
      timeout: 20_000,
    });

    assert.ok(tunnels.includes("api.deepseek.com:443"), "DeepSeek requests must tunnel through HTTPS_PROXY");
    assert.ok(tunnels.includes("api.telegram.org:443"), "Telegram Bot API requests must tunnel through HTTPS_PROXY");
    assert.deepEqual(seenRequests, [
      { method: "POST", url: "/v1/chat/completions", auth: "Bearer __vault_DEEPSEEK_API_KEY__" },
      { method: "POST", url: "/v1/tools/search", auth: "Bearer __vault_DEEPSEEK_WEB_API_KEY__" },
      { method: "POST", url: "/v1/tools/fetch", auth: "Bearer __vault_DEEPSEEK_WEB_API_KEY__" },
      { method: "POST", url: "/bot__vault_TELEGRAM_BOT_TOKEN__/getMe" },
      { method: "POST", url: "/bot__vault_TELEGRAM_BOT_TOKEN__/getWebhookInfo" },
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [proxy, upstream].filter(Boolean).map((server) => new Promise<void>((resolve) => server!.close(() => resolve()))),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("NO_PROXY keeps listed hosts off the proxy", async () => {
  let hits = 0;
  const target = createServer((_request, response) => {
    hits++;
    response.end("ok");
  });
  const targetPort = await listen(target);
  try {
    await withConnectLogger(async (proxyUrl, targets) => {
      await runNode(fetchProbe(`http://127.0.0.1:${targetPort}/`), {
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxyUrl,
        NO_PROXY: "127.0.0.1",
      });
      assert.equal(hits, 1);
      assert.deepEqual(targets, []);
    });
  } finally {
    target.close();
  }
});

test("deployment example, MITM overlay, and allowlist stay aligned without real secrets or insecure TLS", async () => {
  const example = await readFile(join(root, ".env.example"), "utf8");
  const secretLine = /^#?\s*([A-Z0-9_]*(?:_KEY|_TOKEN))=(.*)$/gm;
  const seenSecrets = new Map<string, string>();
  for (const match of example.matchAll(secretLine)) {
    const [, name = "", value = ""] = match;
    const trimmed = value.trim();
    seenSecrets.set(name, trimmed);
    assert.ok(
      trimmed === "" || trimmed === `__vault_${name}__`,
      `${name} must be blank or __vault_${name}__ in .env.example`,
    );
  }
  assert.equal(seenSecrets.get("TELEGRAM_BOT_TOKEN"), "__vault_TELEGRAM_BOT_TOKEN__");
  assert.equal(seenSecrets.get("DEEPSEEK_API_KEY"), "__vault_DEEPSEEK_API_KEY__");
  assert.equal(seenSecrets.get("DEEPSEEK_WEB_API_KEY"), "__vault_DEEPSEEK_WEB_API_KEY__");

  const allowlist = JSON.parse(
    await readFile(join(root, "deploy", "openbao-mitm", "addon", "allowlist.json"), "utf8"),
  ) as Record<string, string[]>;
  for (const entry of Object.values(PROVIDERS)) {
    assert.ok(Array.isArray(allowlist[entry.apiKeyEnv]) && allowlist[entry.apiKeyEnv]!.length > 0, `${entry.apiKeyEnv} must be in allowlist.json`);
  }
  assert.deepEqual(allowlist.DEEPSEEK_API_KEY, ["api.deepseek.com"]);
  assert.deepEqual(allowlist.DEEPSEEK_WEB_API_KEY, ["api.deepseek.com"]);
  assert.deepEqual(allowlist.TELEGRAM_BOT_TOKEN, ["api.telegram.org"]);

  const raw = await readFile(join(root, "docker-compose.mitm.yml"), "utf8");
  const overlay = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(overlay, /NODE_EXTRA_CA_CERTS: \/run\/aster\/mitmproxy-ca\.pem/);
  assert.match(overlay, /NODE_USE_ENV_PROXY: "1"/);
  assert.match(overlay, /HTTPS_PROXY: http:\/\/aster-mitm:14322/);
  assert.match(overlay, /HTTP_PROXY: http:\/\/aster-mitm:14322/);
  assert.match(overlay, /NO_PROXY: localhost,127\.0\.0\.1,::1,aster-mitm,aster-openbao/);
  assert.match(overlay, /name: aster_default/);
  assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED|ssl_insecure|insecure/i.test(overlay));
});

test("MITM placeholder substitution addon unit tests pass", async () => {
  const addonDir = join(root, "deploy", "openbao-mitm", "addon");
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  let lastError: unknown;
  for (const bin of candidates) {
    try {
      const { stderr } = await exec(
        bin,
        ["-B", "-m", "unittest", "discover", "-s", addonDir, "-p", "test_*.py"],
        { timeout: 15_000 },
      );
      assert.match(stderr, /OK/);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
});


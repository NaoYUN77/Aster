import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("Node fetch and grammY tunnel through the configured proxy and trust its CA", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-vault-tls-"));
  const sockets = new Set<Duplex>();
  const requests: string[] = [];
  const tunnels: string[] = [];
  const ca = join(directory, "ca.pem");
  const key = join(directory, "key.pem");
  let proxy: ReturnType<typeof createServer> | undefined;
  let upstream: ReturnType<typeof createHttpsServer> | undefined;
  try {
    const opensslConfig = join(directory, "openssl.cnf");
    await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
    await exec("openssl", ["req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", ca,
      "-days", "1", "-subj", "/CN=api.example.test", "-addext", "subjectAltName=DNS:api.example.test,DNS:api.telegram.org"], { timeout: 10_000 });
    upstream = createHttpsServer({ key: await readFile(key), cert: await readFile(ca) }, (req, res) => {
      requests.push(req.url!);
      if (req.url === "/check") {
        assert.equal(req.headers.authorization, "Bearer __vault_TEST_TOKEN__");
        res.end("proxied");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: req.url?.endsWith("getMe")
          ? { id: 123, is_bot: true, first_name: "test" }
          : { url: "", has_custom_certificate: false, pending_update_count: 0 } }));
      }
    });
    upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    proxy = createServer((_req, res) => { res.writeHead(405).end(); });
    proxy.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url!);
      assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("proxy-token:test-vault").toString("base64")}`);
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
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://proxy-token:test-vault@127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env, AGENT_VAULT_ENABLED: "1", HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
      NO_PROXY: "", NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca,
    };
    for (const name of ["http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"]) delete env[name];
    const result = await exec(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "vault-client.ts")], { env, timeout: 15_000 });
    assert.match(result.stdout, /proxy transport OK/);
    assert.ok(tunnels.includes("api.example.test:443"));
    assert.ok(tunnels.includes("api.telegram.org:443"));
    assert.deepEqual(requests, ["/check", "/bot__vault_TELEGRAM_BOT_TOKEN__/getMe", "/bot__vault_TELEGRAM_BOT_TOKEN__/getWebhookInfo"]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, upstream].filter(Boolean).map((server) => new Promise<void>((resolve) => server!.close(() => resolve()))));
    await rm(directory, { recursive: true, force: true });
  }
});

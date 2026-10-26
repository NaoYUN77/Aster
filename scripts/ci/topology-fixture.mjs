import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
const tls = { key: await readFile("/fixtures/key.pem"), cert: await readFile("/fixtures/test-ca.pem") };
const counts = { login: 0, secrets: 0, getMe: 0, getWebhookInfo: 0, getUpdates: 0, model: 0, sendMessage: 0, acknowledged: 0, protocolFailures: 0 };
let release = false;
let replay = false;
const updateId = 710;
const answer = "Topology acceptance reply.";
const requestText = "Reply with the topology acceptance sentence.";
const update = { update_id: updateId, message: { message_id: 10, date: 1_790_000_000,
  from: { id: 424242, is_bot: false, first_name: "Synthetic" },
  chat: { id: 424242, type: "private", first_name: "Synthetic" }, text: requestText } };

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
function reject(response) {
  counts.protocolFailures++;
  send(response, 400, { ok: false, description: "synthetic protocol mismatch" });
}
async function bodyOf(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("body limit");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  return request.headers["content-type"]?.includes("application/json")
    ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
}
async function handle(request, response) {
  const url = new URL(request.url, "https://fixture");
  const body = await bodyOf(request);
  const host = request.headers.host?.split(":")[0];
  if (host === "infisical.topology.test" && url.pathname === "/api/v1/auth/universal-auth/login") {
    if (request.method !== "POST" || body.clientId !== credentials.clientId || body.clientSecret !== credentials.clientSecret) return reject(response);
    counts.login++;
    return send(response, 200, { accessToken: credentials.accessToken, expiresIn: 7200, accessTokenMaxTTL: 7200, tokenType: "Bearer" });
  }
  if (host === "infisical.topology.test" && url.pathname === "/api/v3/secrets/raw") {
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${credentials.accessToken}`
      || url.searchParams.get("workspaceId") !== "ci-project" || url.searchParams.get("environment") !== "ci"
      || !["/ci/telegram", "/ci/deepseek"].includes(url.searchParams.get("secretPath"))) return reject(response);
    counts.secrets++;
    const telegram = url.searchParams.get("secretPath") === "/ci/telegram";
    return send(response, 200, { secrets: [{ id: "ci-key", _id: "ci-key", secretKey: telegram ? "TELEGRAM_BOT_TOKEN" : "DEEPSEEK_API_KEY",
      secretValue: telegram ? credentials.telegramToken : credentials.modelKey, environment: "ci", workspace: "ci-project",
      type: "shared", version: 1, secretPath: url.searchParams.get("secretPath") }], imports: [] });
  }
  if (host === "api.telegram.org" && url.pathname.startsWith(`/bot${credentials.telegramToken}/`)) {
    const method = url.pathname.split("/").at(-1);
    if (!Object.hasOwn(counts, method) || request.method !== "POST") return reject(response);
    counts[method]++;
    if (method === "getMe") return send(response, 200, { ok: true, result: { id: 900001, is_bot: true, first_name: "CI", username: "ci_topology_bot" } });
    if (method === "getWebhookInfo") return send(response, 200, { ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } });
    if (method === "getUpdates") {
      if (Number(body.offset) >= updateId + 1) counts.acknowledged++;
      if (release || replay) {
        release = false;
        replay = false;
        return send(response, 200, { ok: true, result: [update] });
      }
      await delay(250);
      return send(response, 200, { ok: true, result: [] });
    }
    if (method === "sendMessage" && String(body.chat_id) === "424242" && body.text === answer) {
      return send(response, 200, { ok: true, result: { message_id: 7001, date: 1_790_000_001,
        chat: { id: 424242, type: "private" }, text: answer } });
    }
    return reject(response);
  }
  if (host === "api.deepseek.com" && url.pathname === "/chat/completions") {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${credentials.modelKey}` || body.model !== "deepseek-v4-pro"
      || body.stream !== true || !body.messages?.some((message) => message.role === "user" && JSON.stringify(message.content).includes(requestText))) return reject(response);
    counts.model++;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const base = { id: "ci-completion", object: "chat.completion.chunk", created: 1_790_000_001, model: "deepseek-v4-pro" };
    for (const delta of [{ role: "assistant", content: "Topology acceptance " }, { content: "reply." }]) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      await delay(25);
    }
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  reject(response);
}
const server = https.createServer(tls, (request, response) => {
  handle(request, response).catch(() => { counts.protocolFailures++; if (!response.headersSent) send(response, 500, { ok: false }); else response.end(); });
});
server.requestTimeout = 15_000;
server.maxHeadersCount = 64;
server.listen(443, "0.0.0.0");
http.createServer(async (request, response) => {
  if (request.url !== "/control") return send(response, 404, {});
  try {
    if (request.method === "POST") {
      const body = await bodyOf(request);
      if (body.operation === "release") release = true;
      else if (body.operation === "replay") replay = true;
      else return send(response, 400, {});
    }
    send(response, 200, counts);
  } catch { send(response, 400, {}); }
}).listen(18080, "127.0.0.1");
const udp = dgram.createSocket("udp4");
udp.on("message", (_, remote) => udp.send("topology-udp-response", remote.port, remote.address));
udp.bind(18053, "0.0.0.0");
const dns = dgram.createSocket("udp4");
dns.on("message", (query, remote) => {
  if (query.length < 17) return;
  const response = Buffer.concat([Buffer.from(query), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 172, 30, 82, 2])]);
  response.writeUInt16BE(0x8180, 2);
  response.writeUInt16BE(1, 6);
  dns.send(response, remote.port, remote.address);
});
dns.bind(53, "0.0.0.0");

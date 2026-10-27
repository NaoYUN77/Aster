import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
const tls = { key: await readFile("/fixtures/key.pem"), cert: await readFile("/fixtures/test-ca.pem") };
const counts = { login: 0, secrets: 0, getMe: 0, getWebhookInfo: 0, getUpdates: 0, model: 0, sendMessage: 0, acknowledged: 0,
  apiRequests: 0, policyAllowed: 0, protocolFailures: 0 };
const scenarios = {
  business: { updateId: 710, text: "Reply with the topology acceptance sentence.", answer: "Topology acceptance reply." },
  execution: { updateId: 711, text: "Record the execution marker once, then reply.", answer: "Execution recovered reply." },
  delivery: { updateId: 712, text: "Reply with the three-part delivery acceptance text.", answer: "A".repeat(4000) + "B".repeat(4000) + "Delivery tail." },
};
for (const scenario of Object.values(scenarios)) Object.assign(scenario, { model: 0, sends: [], acknowledged: 0 });
let current = scenarios.business;
let queued = false;
let gate;
function arm(name) {
  if (gate) throw new Error("barrier still armed");
  current = scenarios[name];
  let resume;
  const promise = new Promise((resolve) => { resume = resolve; });
  gate = { name, reached: false, promise, resume };
  queued = true;
}
function snapshot() {
  return { ...counts, scenarios, barrier: gate ? { name: gate.name, reached: gate.reached } : null };
}
async function barrier(name) {
  if (gate?.name !== name) return;
  const waiting = gate;
  waiting.reached = true;
  // The coordinator must kill at this explicit boundary, never after a sleep.
  // A lost coordinator cannot leave unbounded fixture work behind.
  await Promise.race([waiting.promise, delay(90_000, undefined, { ref: false }).then(() => { throw new Error("barrier deadline"); })]);
}

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
  // Count every application upstream request, including malformed/forbidden
  // operations. A broker 403 alone does not prove that no request escaped.
  if (host !== "infisical.topology.test") counts.apiRequests++;
  if (request.headers["x-topology-policy-probe"] === "1") {
    const telegram = host === "api.telegram.org" && request.method === "POST"
      && url.pathname === `/bot${credentials.telegramToken}/getMe`;
    const deepseek = host === "api.deepseek.com" && request.method === "POST" && url.pathname === "/chat/completions"
      && request.headers.authorization === `Bearer ${credentials.modelKey}`;
    if (!telegram && !deepseek) return reject(response);
    counts.policyAllowed++;
    return send(response, 200, { ok: true, policyProbe: "accepted" });
  }
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
      if (Number(body.offset) >= current.updateId + 1) { counts.acknowledged++; current.acknowledged++; }
      if (queued) {
        queued = false;
        const update = { update_id: current.updateId, message: { message_id: current.updateId, date: 1_790_000_000,
          from: { id: 424242, is_bot: false, first_name: "Synthetic" },
          chat: { id: 424242, type: "private", first_name: "Synthetic" }, text: current.text } };
        return send(response, 200, { ok: true, result: [update] });
      }
      await delay(250);
      return send(response, 200, { ok: true, result: [] });
    }
    if (method === "sendMessage" && String(body.chat_id) === "424242") {
      const scenario = Object.values(scenarios).find((item) => item.answer === body.text
        || (item === scenarios.delivery && ["A".repeat(4000), "B".repeat(4000), "Delivery tail."].includes(body.text)));
      if (!scenario) return reject(response);
      // Receipt is recorded before withholding the confirmation, modelling an
      // accepted external write whose result never reaches the application.
      scenario.sends.push(body.text);
      if (scenario === scenarios.delivery && body.text === "B".repeat(4000)) await barrier("delivery");
      return send(response, 200, { ok: true, result: { message_id: 7000 + counts.sendMessage, date: 1_790_000_001,
        chat: { id: 424242, type: "private" }, text: body.text } });
    }
    return reject(response);
  }
  if (host === "api.deepseek.com" && url.pathname === "/chat/completions") {
    const lastUser = body.messages?.findLast((message) => message.role === "user");
    const scenario = Object.values(scenarios).find((item) => JSON.stringify(lastUser?.content)?.includes(item.text));
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${credentials.modelKey}` || body.model !== "deepseek-v4-pro"
      || body.stream !== true || !scenario) return reject(response);
    counts.model++;
    scenario.model++;
    const base = { id: "ci-completion", object: "chat.completion.chunk", created: 1_790_000_001, model: "deepseek-v4-pro" };
    if (scenario === scenarios.execution) {
      const toolResult = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "ci-marker");
      if (!toolResult) {
        if (scenario.model !== 1) return reject(response);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const tool = { index: 0, id: "ci-marker", type: "function", function: { name: "bash",
          arguments: JSON.stringify({ command: "printf 'completed\\n' >> /data/workspace/topology-execution-marker" }) } };
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [tool] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      if (scenario.model > 3) return reject(response);
      await barrier("execution");
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const delta of [{ role: "assistant", content: scenario.answer.slice(0, 20) }, { content: scenario.answer.slice(20) }]) {
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
server.listen({ port: 443, host: "::", ipv6Only: false });
http.createServer(async (request, response) => {
  if (request.url !== "/control") return send(response, 404, {});
  try {
    if (request.method === "POST") {
      const body = await bodyOf(request);
      if (body.operation === "release" || body.operation === "replay") queued = true;
      else if (body.operation === "arm-execution") arm("execution");
      else if (body.operation === "arm-delivery") arm("delivery");
      else if (body.operation === "unblock" && gate?.reached) { gate.resume(); gate = undefined; }
      else if (body.operation === "ipv6-inbound" && net.isIPv6(body.host) && body.host.startsWith("fd82:6173:7465:")) {
        const result = await new Promise((resolve) => {
          const socket = net.connect({ host: body.host, port: 18081 });
          const finish = (value) => { socket.destroy(); resolve(value); };
          socket.once("connect", () => finish("connected"));
          socket.once("error", (error) => finish(error.code === "ETIMEDOUT" ? "timeout" : "network-error"));
          socket.setTimeout(1000, () => finish("timeout"));
        });
        return send(response, 200, { result });
      }
      else return send(response, 400, {});
    }
    send(response, 200, snapshot());
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

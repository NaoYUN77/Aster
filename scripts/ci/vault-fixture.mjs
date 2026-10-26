import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";

const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
const tls = {
  key: await readFile("/fixtures/key.pem"),
  cert: await readFile("/fixtures/ca.pem"),
};
let scenario = {};
let calls = { login: 0, secrets: 0, redirected: 0, authenticated: 0 };

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function handler(request, response) {
  const path = new URL(request.url, "http://fixture").pathname;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  if (path === "/control") {
    if (request.method === "POST") {
      scenario = JSON.parse(body);
      calls = { login: 0, secrets: 0, redirected: 0, authenticated: 0 };
    }
    send(response, 200, calls);
    return;
  }
  if (path === "/received") {
    calls.redirected++;
    send(response, 200, { accessToken: credentials.accessToken, expiresIn: 7200 });
    return;
  }
  const login = path === "/api/v1/auth/universal-auth/login";
  const secrets = path === "/api/v3/secrets/raw";
  if (!login && !secrets) {
    send(response, 404, {});
    return;
  }
  if (login) calls.login++;
  if (secrets) calls.secrets++;
  if (login) {
    const parsed = JSON.parse(body);
    if (parsed.clientId !== credentials.clientId || parsed.clientSecret !== credentials.clientSecret) {
      send(response, 401, { message: "invalid synthetic identity" });
      return;
    }
  } else if (request.headers.authorization !== `Bearer ${credentials.accessToken}`) {
    send(response, 401, { message: "invalid synthetic access token" });
    return;
  } else {
    calls.authenticated++;
  }
  if (scenario.operation === (login ? "login" : "secrets")) {
    if (scenario.redirect) {
      send(response, scenario.status, {}, { Location: scenario.redirect });
      return;
    }
    if (scenario.status) {
      // Exercise both raw 422 bodies and the SDK's parsed `message` error branch.
      send(response, scenario.status, { message: credentials.errorSecret, diagnostic: credentials.errorSecret });
      return;
    }
  }
  if (login) {
    send(response, 200, { accessToken: credentials.accessToken, expiresIn: 7200, accessTokenMaxTTL: 7200, tokenType: "Bearer" });
  } else {
    send(response, 200, {
      secrets: [{ id: "ci-key", _id: "ci-key", secretKey: "CI_KEY", secretValue: credentials.value,
        environment: "ci", workspace: "ci-project", type: "shared", version: 1, secretPath: "/ci" }],
      imports: [],
    });
  }
}

http.createServer((request, response) => {
  handler(request, response).catch(() => send(response, 500, { message: "fixture failure" }));
}).listen(18080, "0.0.0.0");
https.createServer(tls, (request, response) => {
  handler(request, response).catch(() => send(response, 500, { message: "fixture failure" }));
}).listen(18888, "0.0.0.0");
https.createServer(tls, (request, response) => {
  handler(request, response).catch(() => send(response, 500, { message: "fixture failure" }));
}).listen(18890, "0.0.0.0");

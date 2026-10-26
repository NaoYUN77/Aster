import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";

// Exit codes are the only diagnostic this fixture may emit: they are fixed
// values that cannot carry a synthetic credential. 0 is success.
const FAILURES = { credentials: 20, key: 21, certificate: 22, listen: 23, other: 24 };
const fail = (kind) => {
  process.exitCode = FAILURES[kind] ?? FAILURES.other;
  process.exit(process.exitCode);
};
process.on("uncaughtException", () => fail("other"));
process.on("unhandledRejection", () => fail("other"));

let credentials;
try {
  credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
} catch {
  fail("credentials");
}
const tls = { key: undefined, cert: undefined };
try {
  tls.key = await readFile("/fixtures/key.pem");
} catch {
  fail("key");
}
try {
  tls.cert = await readFile("/fixtures/ca.pem");
} catch {
  fail("certificate");
}
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

// createServer throws synchronously on an unusable key/cert pair, and listen
// reports bind failures asynchronously. Both become a fixed exit code.
function start(server, port) {
  server.on("error", () => fail("listen"));
  try {
    server.listen(port, "0.0.0.0");
  } catch {
    fail("certificate");
  }
}
const handle = (request, response) => handler(request, response).catch(() => send(response, 500, { message: "fixture failure" }));
try {
  start(http.createServer(handle), 18080);
  start(https.createServer(tls, handle), 18888);
  start(https.createServer(tls, handle), 18890);
} catch {
  fail("certificate");
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const image = process.env.VAULT_CI_IMAGE ?? "aster-vault:ci";
const fixtureImage = process.env.CI_NODE_IMAGE ?? "node:24.19.0-bookworm-slim";
const id = `aster-ci-vault-${randomBytes(6).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), `${id}-`));
const containers = new Set();
const values = {
  clientId: "ci-identity",
  clientSecret: `ci-client-${randomBytes(24).toString("hex")}`,
  accessToken: `ci-access-${randomBytes(24).toString("hex")}`,
  value: `ci-value-${randomBytes(24).toString("hex")}`,
  errorSecret: `ci-error-${randomBytes(24).toString("hex")}`,
  ownerPassword: `ci-owner-${randomBytes(24).toString("hex")}`,
};
let current = "setup";
let checks = 0;

async function command(program, args, timeout = 120_000) {
  try {
    const output = await exec(program, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    return output.stdout + (program === "docker" && args[0] === "logs" ? output.stderr : "");
  } catch {
    // Child output may contain a secret. Report only the step identifier.
    throw new Error(`command failed during ${current}`);
  }
}
const docker = (...args) => command("docker", args);
function assertClean(text) {
  for (const value of Object.values(values)) {
    if (value === values.clientId) continue;
    for (const encoded of [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]) {
      assert.ok(!text.includes(encoded), "synthetic credential in container logs");
    }
  }
}
async function probe(...args) {
  return docker("exec", id, "node", "/fixtures/vault-probe.mjs", ...args);
}
async function stopBroker(name) {
  await docker("stop", "--time", "15", name);
  assertClean(await docker("logs", name));
  await docker("rm", name);
  containers.delete(name);
}
async function startBroker(name, url, ca = true) {
  containers.add(name);
  await docker("run", "--detach", "--name", name, "--network", `container:${id}`,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/data:uid=65532,gid=65532,mode=0700", "--tmpfs", "/tmp:mode=1777",
    "--mount", `type=bind,source=${resolve(directory)},target=/fixtures,readonly`,
    "--env", `AGENT_VAULT_MASTER_PASSWORD=${values.ownerPassword}`,
    "--env", `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=${values.clientId}`,
    "--env", `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=${values.clientSecret}`,
    "--env", `INFISICAL_URL=${url}`, "--env", "AGENT_VAULT_TELEMETRY=false",
    ...(ca ? ["--env", "SSL_CERT_FILE=/fixtures/ca.pem"] : []),
    image, "server", "--host", "0.0.0.0", "--port", "14321");
  await probe("ready");
  await probe("bootstrap");
}
async function check(name, run) {
  current = name;
  await run();
  checks++;
  console.info(`PASS ${name}`);
}

try {
  current = "generate-test-certificate";
  await writeFile(join(directory, "openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\nCN=infisical.ci.test\n");
  await command(process.env.CI_OPENSSL ?? "openssl", ["req", "-config", join(directory, "openssl.cnf"), "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "ca.pem"), "-days", "1",
    "-subj", "/CN=infisical.ci.test", "-addext", "subjectAltName=DNS:infisical.ci.test,DNS:redirect.ci.test",
  ]);
  current = "start-isolated-fixture";
  // The broker's uid 65532 reads only this synthetic CA through the bind mount.
  await chmod(directory, 0o755);
  await chmod(join(directory, "ca.pem"), 0o644);
  await writeFile(join(directory, "credentials.json"), JSON.stringify(values));
  await Promise.all(["vault-fixture.mjs", "vault-probe.mjs"].map((name) => copyFile(join(source, name), join(directory, name))));
  containers.add(id);
  await docker("run", "--detach", "--name", id, "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:mode=1777",
    "--add-host", "infisical.ci.test:127.0.0.1", "--add-host", "redirect.ci.test:127.0.0.1",
    "--add-host", "wrong.ci.test:127.0.0.1",
    "--mount", `type=bind,source=${resolve(directory)},target=/fixtures,readonly`,
    fixtureImage, "node", "/fixtures/vault-fixture.mjs");
  // A bounded command waits until the fixture can accept control requests.
  await docker("exec", id, "node", "--input-type=module", "-e",
    "const end=Date.now()+10000;for(;;){try{await fetch('http://127.0.0.1:18080/control');break}catch{if(Date.now()>end)process.exit(1);await new Promise(r=>setTimeout(r,100))}}");
  const normal = `${id}-normal`;
  await check("https-sync-and-proxy-authorization", async () => {
    await startBroker(normal, "https://infisical.ci.test:18888");
    await probe("baseline");
  });
  for (const status of [400, 422, 500]) {
    await check(`initial-manual-and-log-error-${status}`, async () => {
      await probe("sync-error", String(status));
      assertClean(await docker("logs", normal));
    });
  }
  await stopBroker(normal);

  const cases = [
    ...[307, 308].flatMap((status) => ["login", "secrets"].map((operation) => ({
      name: `${operation}-cross-origin-${status}`, operation, status,
      redirect: "https://redirect.ci.test:18890/received", expected: operation,
    }))),
    { name: "login-same-origin-redirect", operation: "login", status: 307,
      redirect: "https://infisical.ci.test:18888/received", expected: "login" },
    { name: "login-http-downgrade", operation: "login", status: 307,
      redirect: "http://redirect.ci.test:18080/received", expected: "login" },
    ...[400, 422, 500].map((status) => ({ name: `login-error-${status}`, operation: "login", status, expected: "login" })),
    { name: "reject-http-origin", url: "http://infisical.ci.test:18080", expected: "none" },
    { name: "reject-untrusted-ca", ca: false, expected: "none" },
    { name: "reject-wrong-hostname", url: "https://wrong.ci.test:18888", expected: "none" },
  ];
  for (const [index, scenario] of cases.entries()) {
    await check(scenario.name, async () => {
      await probe("control", JSON.stringify(scenario));
      const name = `${id}-${index}`;
      await startBroker(name, scenario.url ?? "https://infisical.ci.test:18888", scenario.ca ?? true);
      await probe("blocked", scenario.expected);
      await stopBroker(name);
      // Recheck after shutdown so an orphaned startup retry cannot leak later.
      await probe("blocked-stats", scenario.expected);
    });
  }
  console.info(`Vault image regression passed: ${checks} checks; synthetic credentials; no production volumes.`);
} catch {
  console.error(`Vault image regression FAILED: ${current}`);
  process.exitCode = 1;
} finally {
  let cleaned = true;
  for (const name of [...containers].reverse()) {
    try { await docker("rm", "--force", name); } catch { cleaned = false; }
  }
  await rm(directory, { recursive: true, force: true });
  if (!cleaned) {
    console.error(`CI container cleanup failed for run ${id}`);
    process.exitCode = 1;
  }
}

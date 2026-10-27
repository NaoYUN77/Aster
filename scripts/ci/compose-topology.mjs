import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../..");
const renderOnly = process.argv.includes("--render-only");
const project = `aster-ci-topology-${randomBytes(6).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), `${project}-`));
const images = {
  app: process.env.ASTER_IMAGE ?? "aster:ci", router: process.env.ASTER_ROUTER_IMAGE ?? "aster-router:ci",
  network: process.env.ASTER_NETWORK_IMAGE ?? "aster-network:ci", broker: process.env.VAULT_CI_IMAGE ?? "aster-vault:ci",
};
const random = (name) => `ci-${name}-${randomBytes(24).toString("hex")}`;
const credentials = { clientId: random("identity"), clientSecret: random("client"), accessToken: random("access"),
  telegramToken: `900001:${randomBytes(24).toString("hex")}`, modelKey: random("model"),
  ownerPassword: random("owner"), masterPassword: random("master"), routerPassword: random("router") };
const file = (name) => join(directory, name).replaceAll("\\", "/");
const quote = (value) => JSON.stringify(value);
let step = "prepare";
let checks = 0;
let created = false;
let failureCode = "CHECK_FAILED";
const composeArgs = ["compose", "--project-name", project, "--project-directory", root,
  "--env-file", file("empty.env"), "-f", join(root, "docker-compose.agent-vault.yml"),
  "-f", join(root, "docker-compose.router.yml"), "-f", file("override.yml")];

function command(program, args, { input, allowFailure = false, timeout = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, COMPOSE_ENV_FILES: "", COMPOSE_DISABLE_ENV_FILE: "1",
        ASTER_IMAGE: images.app, ASTER_ROUTER_IMAGE: images.router, ASTER_NETWORK_IMAGE: images.network, ASTER_VAULT_IMAGE: images.broker } });
    let output = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const capture = (chunk) => {
      if (output.length + chunk.length > 4 * 1024 * 1024) { overflow = true; child.kill(); }
      else output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", () => { clearTimeout(timer); reject(new Error(`command unavailable during ${step}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!overflow && !timedOut && (code === 0 || allowFailure)) resolvePromise({ code, output });
      else {
        const probeFailure = output.match(/Topology probe failed: ([a-z0-9:-]+)(?: \(line (\d+)\))?/u);
        failureCode = probeFailure ? `PROBE_${probeFailure[1]}${probeFailure[2] ? `_LINE_${probeFailure[2]}` : ""}`
          : output.includes("env file") ? "COMPOSE_ENV_FILE" : output.includes("network_mode") ? "COMPOSE_NETWORK_MODE"
          : output.includes("yaml") ? "COMPOSE_YAML" : `COMMAND_EXIT_${code ?? "SIGNAL"}`;
        reject(new Error(`command failed during ${step}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const docker = (...args) => command("docker", args);
const compose = (...args) => docker(...composeArgs, ...args);
const probe = (...args) => compose("exec", "-T", "topology-fixture", "node", "/fixtures/topology-probe.mjs", ...args);
function assertClean(text) {
  for (const secret of Object.values(credentials)) {
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")]) {
      assert.ok(!text.includes(value), "synthetic credential appeared in prohibited output");
    }
  }
}
async function check(name, fn) {
  step = name;
  await fn();
  checks++;
  console.info(`PASS ${name}`);
}

try {
  assert.ok(process.argv.slice(2).every((value) => value === "--render-only"), "unsupported option");
  await chmod(directory, 0o755);
  await writeFile(file("empty.env"), "");
  await writeFile(file("credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(file("telegram-owner-id"), "424242\n", { mode: 0o644 });
  const rules = [
    ...["getMe", "getWebhookInfo", "getUpdates", "sendMessage"].map((method) => ({ vault: "telegram",
      target: "api.telegram.org:443", method: "POST", path: `/bot__vault_TELEGRAM_BOT_TOKEN__/${method}` })),
    { vault: "deepseek", target: "api.deepseek.com:443", method: "POST", path: "/chat/completions" },
  ];
  // JSON is a YAML subset; these exact placeholder paths never contain a real token.
  await writeFile(file("api-policy.yaml"), JSON.stringify({ version: 1, rules }), { mode: 0o644 });
  await Promise.all(["topology-fixture.mjs", "topology-probe.mjs"].map((name) => copyFile(join(source, name), file(name))));
  await writeFile(file("router-config.json"), JSON.stringify({ listen: "127.0.0.1:14323", upstream_proxy: "172.30.82.2:14322",
    client_auth: { username: "app", password_files: ["/etc/aster-router/client-password"] },
    routes: ["telegram", "deepseek"].map((name) => ({ name, host: name === "telegram" ? "api.telegram.org" : "api.deepseek.com", port: 443,
      vault: name, agent_token_file: `/etc/aster-router/agent-token-${name}` })), allowed_ports: [443],
    timeouts: { dial: "5s", upstream_header: "10s", idle: "1m", shutdown: "5s" },
    log: { level: "info", format: "json", access: true }, health_listen: "127.0.0.1:14324" }));
  const proxy = `http://app:${credentials.routerPassword}@127.0.0.1:14323`;
  const override = `services:
  topology-fixture:
    image: ${quote(images.app)}
    user: "0:0"
    entrypoint: ["node"]
    command: ["/fixtures/topology-fixture.mjs"]
    restart: "no"
    read_only: true
    cap_drop: ["ALL"]
    cap_add: ["NET_BIND_SERVICE", "CHOWN", "FOWNER", "DAC_OVERRIDE"]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:size=8m", "/data:size=1m"]
    volumes:
      - type: bind
        source: ${quote(directory)}
        target: /fixtures
        read_only: true
      - topology-router:/router
      - topology-ca:/app-ca
    networks:
      vault:
        ipv4_address: 172.30.82.2
        ipv6_address: fd82:6173:7465::2
    extra_hosts:
      infisical.topology.test: 172.30.82.2
      api.telegram.org: 172.30.82.2
      api.deepseek.com: 172.30.82.2
      unknown.topology.test: 172.30.82.2
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:18080/control').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 3s
      retries: 15
    mem_limit: 128m
    pids_limit: 32
  agent-vault:
    image: ${quote(images.broker)}
    entrypoint: !reset null
    command: !override ["server", "--host", "0.0.0.0", "--port", "14321"]
    env_file: !override []
    environment: !override
      AGENT_VAULT_MASTER_PASSWORD: ${quote(credentials.masterPassword)}
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: ${quote(credentials.clientId)}
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: ${quote(credentials.clientSecret)}
      INFISICAL_URL: https://infisical.topology.test
      SSL_CERT_FILE: /fixtures/test-ca.pem
      AGENT_VAULT_ALLOW_PRIVATE_RANGES: "true"
      AGENT_VAULT_TELEMETRY: "false"
      ASTER_VAULT_API_POLICY: /etc/aster-vault/api-policy.yaml
    restart: "no"
    ports: !override []
    networks: !reset {}
    network_mode: service:topology-fixture
    depends_on:
      topology-fixture: {condition: service_healthy}
    volumes: !override
      - agent-vault-data:/data
      - type: bind
        source: ${quote(file("test-ca.pem"))}
        target: /fixtures/test-ca.pem
        read_only: true
      - type: bind
        source: ${quote(file("api-policy.yaml"))}
        target: /etc/aster-vault/api-policy.yaml
        read_only: true
        bind:
          create_host_path: false
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:14321/health"]
      interval: 1s
      timeout: 3s
      retries: 20
  tool-network:
    image: ${quote(images.network)}
    environment: !override
      ROUTER_ENABLED: "1"
    dns: ["172.30.82.2"]
  egress-router:
    image: ${quote(images.router)}
    restart: "no"
    volumes: !override
      - topology-router:/etc/aster-router:ro
  personal-agent:
    image: ${quote(images.app)}
    restart: "no"
    env_file: !override []
    environment: !override
      DATA_DIR: /data
      HOME: /data
      NPM_CONFIG_CACHE: /data/.npm
      AGENT_VAULT_ENABLED: "1"
      NODE_USE_ENV_PROXY: "1"
      NODE_EXTRA_CA_CERTS: /etc/agent-vault/ca.pem
      NO_PROXY: localhost,127.0.0.1,::1
      TELEGRAM_BOT_TOKEN: __vault_TELEGRAM_BOT_TOKEN__
      TELEGRAM_OWNER_ID_FILE: /run/secrets/telegram-owner-id
      MODEL_PROVIDER: deepseek
      MODEL_ID: deepseek-v4-pro
      DEEPSEEK_API_KEY: __vault_DEEPSEEK_API_KEY__
      HTTP_PROXY: ${quote(proxy)}
      HTTPS_PROXY: ${quote(proxy)}
    volumes: !override
      - personal-agent-data:/data
      - topology-ca:/etc/agent-vault:ro
      - type: bind
        source: ${quote(file("topology-probe.mjs"))}
        target: /ci/topology-probe.mjs
        read_only: true
networks:
  vault:
    enable_ipv6: true
    ipam:
      config: !override
        - subnet: 172.30.82.0/24
        - subnet: fd82:6173:7465::/64
volumes:
  personal-agent-data:
    name: ${project}-app
  agent-vault-data:
    name: ${project}-vault
  topology-router:
    name: ${project}-router
  topology-ca:
    name: ${project}-ca
secrets:
  telegram-owner-id:
    file: ${quote(file("telegram-owner-id"))}
`;
  // Bind sources exist even during a render-only run; no private/production files are read.
  await writeFile(file("test-ca.pem"), "");
  await writeFile(file("override.yml"), override, { mode: 0o600 });
  await check("compose-isolated-resources-and-production-boundaries", async () => {
    const result = await compose("config", "--format", "json");
    const config = JSON.parse(result.output);
    const app = config.services["personal-agent"];
    const router = config.services["egress-router"];
    const network = config.services["tool-network"];
    const broker = config.services["agent-vault"];
    assert.equal(app.user, "1000:1000");
    assert.equal(router.user, "1001:1001");
    assert.equal(app.network_mode, "service:tool-network");
    assert.equal(router.network_mode, "service:tool-network");
    assert.equal(broker.network_mode, "service:topology-fixture");
    assert.equal(config.services["topology-fixture"].networks.vault.ipv4_address, "172.30.82.2");
    assert.equal(config.services["topology-fixture"].networks.vault.ipv6_address, "fd82:6173:7465::2");
    assert.equal(config.networks.vault.enable_ipv6, true);
    assert.equal(network.environment.ROUTER_ENABLED, "1");
    assert.equal(network.read_only, true);
    assert.deepEqual(network.cap_add, ["NET_ADMIN"]);
    assert.equal(app.read_only, true);
    assert.equal(router.read_only, true);
    assert.deepEqual(app.cap_drop, ["ALL"]);
    assert.deepEqual(router.cap_drop, ["ALL"]);
    assert.ok(!app.command && !app.entrypoint, "app must run its final image command");
    assert.ok(!router.command && !router.entrypoint, "router must run its final image command");
    assert.ok(!Object.hasOwn(app.environment, "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"));
    assert.ok(!Object.hasOwn(app.environment, "AGENT_VAULT_MASTER_PASSWORD"));
    assert.equal(app.environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(app.environment.DEEPSEEK_API_KEY, "__vault_DEEPSEEK_API_KEY__");
    assert.equal(broker.image, images.broker);
    assert.equal(broker.environment.ASTER_VAULT_API_POLICY, "/etc/aster-vault/api-policy.yaml");
    const policyMount = broker.volumes.filter((volume) => volume.target === broker.environment.ASTER_VAULT_API_POLICY);
    assert.equal(policyMount.length, 1);
    assert.equal(policyMount[0].type, "bind");
    assert.equal(resolve(policyMount[0].source), resolve(file("api-policy.yaml")));
    assert.equal(policyMount[0].read_only, true);
    // create_host_path only stops Compose from creating a missing source; here the
    // source is the synthetic file written before rendering. Renderers differ on
    // echoing that default, so assert it only when bind options are emitted.
    if (policyMount[0].bind) assert.equal(policyMount[0].bind.create_host_path, false);
    assert.ok(!app.environment.ASTER_VAULT_API_POLICY && !router.environment?.ASTER_VAULT_API_POLICY);
    for (const volume of Object.values(config.volumes)) assert.ok(volume.name.startsWith(`${project}-`) && !volume.external);
    for (const service of Object.values(config.services)) {
      assert.ok(!service.ports?.length, "CI must not publish management or proxy ports");
      assert.ok(!service.env_file?.length, "CI must not use host credential files");
      for (const volume of service.volumes ?? []) {
        if (volume.type === "bind") assert.ok(resolve(volume.source) === resolve(directory)
          || resolve(volume.source).startsWith(`${resolve(directory)}${process.platform === "win32" ? "\\" : "/"}`));
        else assert.ok(volume.type === "volume" && Object.hasOwn(config.volumes, volume.source), "CI must use declared isolated volumes");
      }
      for (const secret of service.secrets ?? []) assert.equal(secret.source, "telegram-owner-id");
      assert.ok(!service.configs?.length, "CI must not import host configs");
    }
    assert.deepEqual(Object.keys(config.secrets), ["telegram-owner-id"]);
    assert.equal(config.secrets["telegram-owner-id"].external, undefined);
    assert.equal(resolve(config.secrets["telegram-owner-id"].file), resolve(file("telegram-owner-id")));
    assert.ok(config.networks.vault.name.startsWith(`${project}_`));
  });
  if (!renderOnly) {
    await check("final-images-present", async () => {
      for (const image of new Set(Object.values(images))) await docker("image", "inspect", image, "--format", "{{.Id}}");
    });
    await check("generate-private-test-ca", async () => {
      await writeFile(file("openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\nCN=infisical.topology.test\n");
      await command(process.env.CI_OPENSSL ?? "openssl", ["req", "-config", file("openssl.cnf"), "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", file("key.pem"), "-out", file("test-ca.pem"), "-days", "1", "-subj", "/CN=infisical.topology.test",
        "-addext", "subjectAltName=DNS:infisical.topology.test,DNS:api.telegram.org,DNS:api.deepseek.com"]);
      await chmod(file("test-ca.pem"), 0o644);
    });
    created = true;
    await check("broker-https-secret-sync-and-proxy-permissions", async () => {
      await compose("up", "--detach", "--no-build", "--pull", "never", "agent-vault");
      await probe("ready");
      await probe("bootstrap");
    });
    await check("broker-decrypted-api-policy-allow-and-deny", async () => {
      await probe("api-policy");
    });
    await check("final-main-telegram-streamed-model-delivery", async () => {
      await compose("up", "--detach", "--no-build", "--pull", "never", "personal-agent");
      await probe("release");
      await probe("business");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "persistent-files");
    });
    await check("network-live-positive-controls", async () => {
      await compose("exec", "-T", "--user", "0:0", "personal-agent", "node", "/ci/topology-probe.mjs", "root-network");
    });
    await check("uid1000-firewall-connect-and-target-deny", async () => {
      await compose("exec", "-T", "--user", "1000:1000", "personal-agent", "node", "/ci/topology-probe.mjs", "app-network");
    });
    await check("single-instance-volume-lock", async () => {
      const result = await command("docker", [...composeArgs, "run", "--rm", "--no-deps", "personal-agent"], { allowFailure: true, timeout: 15_000 });
      assert.equal(result.code, 1, "same-volume second entrypoint must fail flock");
      assertClean(result.output);
    });
    await check("sigterm-restart-does-not-repeat-completed-request", async () => {
      await compose("stop", "--timeout", "20", "personal-agent");
      const id = (await compose("ps", "--all", "--quiet", "personal-agent")).output.trim();
      const state = JSON.parse((await docker("inspect", id, "--format", "{{json .State}}")).output);
      assert.equal(state.ExitCode, 0);
      assert.equal(state.OOMKilled, false);
      await probe("replay");
      await compose("start", "personal-agent");
      await probe("restored", "2");
    });
    await check("sigkill-restart-retains-completed-request", async () => {
      await compose("kill", "--signal", "SIGKILL", "personal-agent");
      await probe("replay");
      await compose("start", "personal-agent");
      await probe("restored", "3");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "persistent-files");
    });
    await check("sigkill-during-execution-resumes-without-repeating-completed-tool", async () => {
      await probe("arm-execution");
      await probe("execution-barrier");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "execution-pending");
      await compose("kill", "--signal", "SIGKILL", "personal-agent");
      await compose("run", "--rm", "--no-deps", "--entrypoint", "node", "personal-agent", "/ci/topology-probe.mjs", "execution-pending");
      await probe("unblock");
      await probe("replay");
      await compose("start", "personal-agent");
      await probe("execution-restored");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "execution-sent");
    });
    await check("sigkill-during-delivery-quarantines-only-unconfirmed-part", async () => {
      await probe("arm-delivery");
      await probe("delivery-barrier");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "delivery-sending");
      await compose("kill", "--signal", "SIGKILL", "personal-agent");
      await compose("run", "--rm", "--no-deps", "--entrypoint", "node", "personal-agent", "/ci/topology-probe.mjs", "delivery-sending");
      await probe("unblock");
      await probe("replay");
      await compose("start", "personal-agent");
      await probe("delivery-blocked");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "delivery-uncertain");
      // The synthetic recipient accepted part 1. Follow the operator contract:
      // stop the app, inspect the real CLI, then mark only that part as sent.
      await compose("stop", "--timeout", "20", "personal-agent");
      await compose("run", "--rm", "--no-deps", "--entrypoint", "node", "personal-agent", "/ci/topology-probe.mjs", "delivery-reconcile");
      await compose("start", "personal-agent");
      await probe("delivery-restored");
      await compose("exec", "-T", "personal-agent", "node", "/ci/topology-probe.mjs", "delivery-sent");
    });
    await check("ipv6-live-positive-control-and-uid1000-uid1001-deny", async () => {
      await compose("exec", "-T", "--user", "0:0", "personal-agent", "node", "/ci/topology-probe.mjs", "root-ipv6");
      await compose("exec", "-T", "--user", "1000:1000", "personal-agent", "node", "/ci/topology-probe.mjs", "app-ipv6");
      await compose("exec", "-T", "--user", "1001:1001", "personal-agent", "node", "/ci/topology-probe.mjs", "router-ipv6");
    });
    await check("ipv6-live-listener-rejects-inbound-tcp", async () => {
      await compose("exec", "--detach", "--user", "0:0", "personal-agent", "node", "/ci/topology-probe.mjs", "ipv6-inbound-listen");
      try {
        const address = (await compose("exec", "-T", "--user", "0:0", "personal-agent", "node", "/ci/topology-probe.mjs", "ipv6-inbound-ready")).output.trim();
        assert.match(address, /^fd82:6173:7465:[a-f0-9:]+$/u);
        await probe("ipv6-inbound", address);
      } finally {
        await compose("exec", "-T", "--user", "0:0", "personal-agent", "node", "/ci/topology-probe.mjs", "ipv6-inbound-stop");
      }
    });
    await check("container-logs-do-not-contain-synthetic-credentials", async () => {
      await compose("stop", "--timeout", "20", "personal-agent", "egress-router", "agent-vault");
      const logs = await compose("logs", "--no-color");
      assertClean(logs.output);
    });
    console.info(`Topology acceptance passed: ${checks} checks; final images; isolated synthetic resources.`);
    console.info("NOT COVERED: interrupted unsafe tool replay; public IPv6/DNS IPv6 positive controls; allowed API query/body semantics and credential-echo prevention; release/prod admission.");
  } else {
    console.info("Compose render checks passed; runtime topology was not executed.");
  }
} catch (error) {
  const line = error?.stack?.match(/compose-topology\.mjs:(\d+):/u)?.[1];
  console.error(`Topology acceptance FAILED: ${step} (${failureCode}${line ? `; check-line ${line}` : ""})`);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await compose("stop", "--timeout", "20");
      assertClean((await compose("logs", "--no-color")).output);
    } catch { console.error("Topology shutdown/log-scan FAILED"); process.exitCode = 1; }
    try { await compose("down", "--volumes", "--remove-orphans", "--timeout", "20"); }
    catch { console.error(`Topology cleanup FAILED for isolated project ${project}`); process.exitCode = 1; }
  }
  await rm(directory, { recursive: true, force: true });
}

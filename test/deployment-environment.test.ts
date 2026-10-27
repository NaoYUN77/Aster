import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDistinctEnvironments, EnvironmentError, ipv4Range, parseEnvironment,
  readEnvironment, type DeploymentEnvironment,
} from "../src/deployment-environment.js";
import { checkRenderedProject, DeploymentRenderError } from "../src/deployment-render.js";
import { checkRouterConfig, RouterConfigError } from "../src/deployment-router.js";
import { composeEnvironment } from "../src/deployment-environment-check.js";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/deployment-environment-check.ts", import.meta.url));

function environment(overrides: Partial<DeploymentEnvironment> = {}): DeploymentEnvironment {
  return {
    schemaVersion: 1,
    kind: "aster.deployment-environment",
    environment: "test",
    composeProject: "aster-test",
    volumes: { app: "aster-test-app-data", broker: "aster-test-vault-data" },
    network: { name: "aster-test-vault", subnet: "172.31.82.0/24", brokerAddress: "172.31.82.2" },
    broker: { managementPort: 15321 },
    privateDirectory: "/srv/aster/test/private",
    privateFiles: {
      vaultEnv: "vault.env", appEnv: "app.env", appRouterEnv: "app.router.env", apiPolicy: "api-policy.yaml",
      ca: "ca.pem", telegramOwnerId: "telegram-owner-id", routerDirectory: "router",
    },
    identity: { botId: "111111" },
    ...overrides,
  };
}
const production = () => environment({
  environment: "production",
  composeProject: "aster-production",
  volumes: { app: "personal-agent-data", broker: "personal-agent-vault-data" },
  network: { name: "aster-production-vault", subnet: "172.30.82.0/24", brokerAddress: "172.30.82.2" },
  broker: { managementPort: 14321 },
  privateDirectory: "/srv/aster/production/private",
  identity: { botId: "222222" },
});
const parse = (value: unknown) => parseEnvironment(Buffer.from(JSON.stringify(value)));
const environmentCode = (code: string) => (error: unknown) => error instanceof EnvironmentError && error.code === code;

test("a description is accepted only with canonical, self-consistent resources", () => {
  assert.deepEqual(parse(environment()), environment());
  assert.deepEqual(parse(production()), production());
  // The network name may be omitted; Compose then derives an already project-unique name.
  const unnamed = environment();
  delete (unnamed.network as { name?: string }).name;
  assert.deepEqual(parse(unnamed).network.name, undefined);

  // The app and broker roles cannot share one volume; that is a resource overlap, not a schema slip.
  assert.throws(() => parse({ ...environment(), volumes: { app: "same", broker: "same" } }), environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
  const bad: unknown[] = [
    null, [], {},
    { ...environment(), schemaVersion: "1" }, { ...environment(), schemaVersion: 2 },
    { ...environment(), kind: "aster.release-bindings" }, { ...environment(), environment: "staging" },
    { ...environment(), accepted: true }, { ...environment(), productionAdmission: "ok" },
    { ...environment(), composeProject: "Aster_Test" }, { ...environment(), composeProject: "a" },
    { ...environment(), volumes: { app: "app", broker: "broker", extra: "x" } },
    { ...environment(), network: { ...environment().network, subnet: "172.31.0.0" } },
    // Broker outside the subnet, or on the network/broadcast address, cannot be reached reliably.
    { ...environment(), network: { ...environment().network, brokerAddress: "172.32.82.2" } },
    { ...environment(), network: { ...environment().network, brokerAddress: "172.31.82.0" } },
    { ...environment(), network: { ...environment().network, brokerAddress: "172.31.82.255" } },
    { ...environment(), network: { ...environment().network, brokerAddress: "fd00::2" } },
    { ...environment(), broker: { managementPort: 0 } }, { ...environment(), broker: { managementPort: 70000 } },
    { ...environment(), broker: { managementPort: "15321" } },
    { ...environment(), privateDirectory: "relative/private" },
    { ...environment(), privateDirectory: "/srv/aster/../production/private" },
    { ...environment(), privateDirectory: "/" },
    { ...environment(), identity: { botId: "0" } }, { ...environment(), identity: { botId: "-1" } },
    { ...environment(), identity: { botId: "bot" } }, { ...environment(), identity: {} },
  ];
  for (const value of bad) assert.throws(() => parse(value), environmentCode("ENVIRONMENT_INVALID_SCHEMA"), JSON.stringify(value));
  // Two private files resolving to one host path is a resource overlap, not a schema slip.
  assert.throws(() => parse({ ...environment(), privateFiles: { ...environment().privateFiles, ca: "vault.env" } }),
    environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
  // An unsupported address family or an unusable prefix is reported distinctly from a schema slip.
  assert.throws(() => parse({ ...environment(), network: { ...environment().network, subnet: "fd00::/64" } }),
    environmentCode("ENVIRONMENT_UNSUPPORTED_NETWORK"));
  assert.throws(() => parse({ ...environment(), network: { ...environment().network, subnet: "172.0.0.0/7" } }),
    environmentCode("ENVIRONMENT_UNSUPPORTED_NETWORK"));
});

test("the checked-in examples parse and describe two distinct environments", async () => {
  const examples = join(checkout, "deploy", "environments");
  const testEnvironment = await readEnvironment(join(examples, "test.example.json"));
  const production = await readEnvironment(join(examples, "production.example.json"));
  assert.equal(testEnvironment.environment, "test");
  assert.equal(production.environment, "production");
  assert.doesNotThrow(() => assertDistinctEnvironments(testEnvironment, production));
});

test("strict JSON rejects duplicates, BOM, malformed UTF-8 and oversized input", () => {
  const good = JSON.stringify(environment());
  const duplicate = good.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  assert.throws(() => parseEnvironment(Buffer.from(duplicate)), environmentCode("ENVIRONMENT_DUPLICATE_KEY"));
  assert.throws(() => parseEnvironment(Buffer.from(`﻿${good}`)), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.from([0xff])), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.from("{")), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.alloc(64 * 1024 + 1)), environmentCode("ENVIRONMENT_TOO_LARGE"));
});

test("two environments are distinct only when no host resource is shared", () => {
  assert.doesNotThrow(() => assertDistinctEnvironments(parse(environment()), parse(production())));
  const changes: Array<(value: DeploymentEnvironment) => void> = [
    (value) => { value.composeProject = "aster-test"; },
    (value) => { value.network.subnet = "172.31.82.0/24"; value.network.brokerAddress = "172.31.82.2"; },
    (value) => { value.network.subnet = "172.31.82.128/25"; value.network.brokerAddress = "172.31.82.129"; },
    (value) => { value.network.name = "aster-test-vault"; },
    (value) => { value.volumes.app = "aster-test-app-data"; },
    (value) => { value.volumes.broker = "aster-test-vault-data"; },
    (value) => { value.broker.managementPort = 15321; },
    (value) => { value.privateDirectory = "/srv/aster/test/private"; },
    (value) => { value.privateDirectory = "/srv/aster/test"; },
    (value) => { value.identity.botId = "111111"; },
  ];
  for (const change of changes) {
    const other = structuredClone(production());
    change(other);
    assert.throws(() => assertDistinctEnvironments(parse(environment()), parse(other)), environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
  }
  // Adjacent but disjoint subnets are a legitimate parallel deployment.
  const adjacent = production();
  adjacent.network = { name: "aster-production-vault", subnet: "172.30.83.0/24", brokerAddress: "172.30.83.2" };
  assert.doesNotThrow(() => assertDistinctEnvironments(parse(environment()), parse(adjacent)));
  // The same environment twice is never a valid comparison.
  assert.throws(() => assertDistinctEnvironments(parse(environment()), parse(environment())), environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
});

test("subnet overlap uses the full address range, not the literal prefix", () => {
  assert.deepEqual(ipv4Range("172.30.82.0/24"), { start: 0xac1e5200, end: 0xac1e52ff });
  assert.deepEqual(ipv4Range("10.0.0.0/8"), { start: 0x0a000000, end: 0x0affffff });
  // /31 and /32 have no interior address for the broker role, and prefixes shorter than /8 are
  // outside the supported range.
  assert.equal(ipv4Range("10.0.0.0/31"), undefined);
  assert.equal(ipv4Range("10.0.0.1/32"), undefined);
  assert.equal(ipv4Range("10.0.0.0/7"), undefined);
  assert.equal(ipv4Range("fd00::/64"), undefined);
});

test("the router configuration must point at this environment's broker", () => {
  const router = (upstream: string) => Buffer.from(JSON.stringify({
    listen: "127.0.0.1:14323", upstream_proxy: upstream, health_listen: "127.0.0.1:14324",
    client_auth: { username: "app", password_files: ["/etc/aster-router/client-password"] }, routes: [],
  }));
  const options = { environment: parse(environment()), brokerPort: 14322 };
  assert.deepEqual(checkRouterConfig(router("172.31.82.2:14322"), options),
    { status: "router-config-matches-environment", productionAdmission: "not-evaluated" });
  const reject = (code: string) => (error: unknown) => error instanceof RouterConfigError && error.code === code;
  assert.throws(() => checkRouterConfig(router("172.30.82.2:14322"), options), reject("ROUTER_UPSTREAM_MISMATCH"));
  assert.throws(() => checkRouterConfig(router("172.31.82.2:14323"), options), reject("ROUTER_UPSTREAM_MISMATCH"));
  assert.throws(() => checkRouterConfig(router("api.example.com:14322"), options), reject("ROUTER_UPSTREAM_MISMATCH"));
  assert.throws(() => checkRouterConfig(router("172.31.82.2:14322"), { ...options, brokerPort: 14323 }), reject("ROUTER_UPSTREAM_MISMATCH"));
  const exposed = JSON.parse(router("172.31.82.2:14322").toString());
  exposed.listen = "0.0.0.0:14323";
  assert.throws(() => checkRouterConfig(Buffer.from(JSON.stringify(exposed)), options), reject("ROUTER_LISTEN_NOT_LOOPBACK"));
  assert.throws(() => checkRouterConfig(Buffer.from('{"listen":"127.0.0.1:14323","upstream_proxy":"172.31.82.2:14322","upstream_proxy":"10.0.0.1:1"}'), options),
    reject("ROUTER_DUPLICATE_KEY"));
});

test("a rendered project must match the description in every host-visible resource", async (t) => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "aster-private-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  await Promise.all(["vault.env", "app.env", "app.router.env", "api-policy.yaml", "ca.pem", "telegram-owner-id"]
    .map((name) => writeFile(join(privateDirectory, name), "")));
  await mkdir(join(privateDirectory, "router"));
  const value = parse(environment());
  const assignments = composeEnvironment(value, privateDirectory);

  function compose(extra: string[], overrides: Record<string, string> = {}) {
    const path = join(privateDirectory, `render-${Math.random().toString(16).slice(2)}.env`);
    writeFileSync(path, Object.entries({ ...assignments, ...overrides }).map(([key, entry]) => `${key}=${entry}\n`).join(""));
    return spawnSync("docker", ["compose", "--project-name", value.composeProject, "--project-directory", checkout,
      "--env-file", path, "-f", join(checkout, "docker-compose.agent-vault.yml"),
      ...extra.flatMap((file) => ["-f", join(checkout, file)]), "config", "--format", "json"],
    { cwd: checkout, encoding: "utf8", timeout: 120_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ASTER_") && !key.startsWith("COMPOSE_"))) });
  }
  const rendered = compose([]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const check = (bytes: string, overrides: Partial<Parameters<typeof checkRenderedProject>[1]> = {}) => checkRenderedProject(
    Buffer.from(bytes),
    { environment: value, privateDirectory, projectName: value.composeProject, managementLoopback: false, routerEnabled: false, ...overrides },
  );
  assert.deepEqual(check(rendered.stdout),
    { status: "render-matches-environment", environment: "test", composeProject: "aster-test", productionAdmission: "not-evaluated" });

  const renderCode = (code: string) => (error: unknown) => error instanceof DeploymentRenderError && error.code === code;
  // A description that changes a resource must not accept a project rendered from other values.
  for (const [overrides, expected] of [
    [{ ASTER_VAULT_SUBNET: "172.30.82.0/24", ASTER_BROKER_ADDRESS: "172.30.82.2" }, "RENDER_NETWORK_MISMATCH"],
    [{ ASTER_APP_VOLUME: "personal-agent-data" }, "RENDER_VOLUME_MISMATCH"],
    [{ ASTER_BROKER_VOLUME: "personal-agent-vault-data" }, "RENDER_VOLUME_MISMATCH"],
    [{ ASTER_BROKER_MANAGEMENT_PORT: "14321" }, "RENDER_MANAGEMENT_PORT_MISMATCH"],
    [{ ASTER_NETWORK_NAME: "aster-production-vault" }, "RENDER_NETWORK_MISMATCH"],
  ] as const) {
    const tampered = compose([], overrides as Record<string, string>);
    assert.equal(tampered.status, 0, tampered.stderr);
    assert.throws(() => check(tampered.stdout), renderCode(expected));
  }
  // A different private directory is a different deployment: the mounts must not point elsewhere.
  const otherPrivate = await mkdtemp(join(tmpdir(), "aster-private-other-"));
  t.after(() => rm(otherPrivate, { recursive: true, force: true }));
  await Promise.all(["vault.env", "app.env", "app.router.env", "api-policy.yaml", "ca.pem", "telegram-owner-id"]
    .map((name) => writeFile(join(otherPrivate, name), "")));
  const relocated = compose([], { ASTER_PRIVATE_DIR: otherPrivate });
  assert.equal(relocated.status, 0, relocated.stderr);
  assert.throws(() => check(relocated.stdout), renderCode("RENDER_PRIVATE_DIRECTORY_MISMATCH"));
  // Mounting a different file from the same private directory is still a different secret.
  for (const [name, file] of [["ca", "other.pem"], ["apiPolicy", "other-policy.yaml"]] as const) {
    const renamed = parse({ ...environment(), privateFiles: { ...environment().privateFiles, [name]: file } });
    assert.throws(() => check(rendered.stdout, { environment: renamed }), renderCode("RENDER_PRIVATE_DIRECTORY_MISMATCH"));
  }
  // Project name and service set are part of the identity.
  assert.throws(() => checkRenderedProject(Buffer.from(rendered.stdout), {
    environment: value, privateDirectory, projectName: "aster-production", managementLoopback: false, routerEnabled: false,
  }), renderCode("RENDER_PROJECT_MISMATCH"));
  const router = compose(["docker-compose.router.yml"]);
  assert.equal(router.status, 0, router.stderr);
  assert.throws(() => check(router.stdout), renderCode("RENDER_SERVICE_MISSING"));
  assert.deepEqual(check(router.stdout, { routerEnabled: true }).status, "render-matches-environment");
  // A router environment whose rendered project is actually the single-vault one is rejected.
  const loopback = compose(["docker-compose.management-loopback.yml"]);
  assert.equal(loopback.status, 0, loopback.stderr);
  assert.throws(() => check(loopback.stdout), renderCode("RENDER_MANAGEMENT_EXPOSED"));
  assert.deepEqual(check(loopback.stdout, { managementLoopback: true }).status, "render-matches-environment");
});

test("CLI reports fixed codes without echoing paths, values or environment contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-env-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = "DO_NOT_PRINT_SYNTHETIC_SECRET";
  const path = join(directory, "environment.json");
  await writeFile(path, JSON.stringify({ ...environment(), privateDirectory: `/srv/${marker}` }));
  await writeFile(join(directory, "valid.json"), JSON.stringify(environment()));
  await writeFile(join(directory, "broken.json"), `{ ${marker}`);
  const run = (argv: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
    cwd: checkout, encoding: "utf8", timeout: 60_000,
  });
  const missing = run(["compare", "--first", join(directory, "absent.json"), "--second", path]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr.includes(marker), false);
  assert.equal(JSON.parse(missing.stderr).productionAdmission, "not-evaluated");
  const broken = run(["compare", "--first", join(directory, "broken.json"), "--second", path]);
  assert.equal(JSON.parse(broken.stderr).code, "ENVIRONMENT_INVALID_JSON");
  assert.equal(broken.stderr.includes(marker), false);
  // A private directory that does not exist would make Compose mount an empty secret file.
  const absent = run(["render", "--environment", join(directory, "valid.json"), "--private-dir", join(directory, "absent")]);
  assert.equal(absent.status, 1);
  assert.equal(JSON.parse(absent.stderr).code, "RENDER_PRIVATE_DIRECTORY_MISMATCH");
  assert.equal(absent.stderr.includes(marker), false);
  for (const argv of [[], ["unknown"], ["compare"], ["compare", "--first", path, "--second", path, "extra"]]) {
    const result = run(argv);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "ARGUMENTS_INVALID");
    assert.equal(result.stderr.includes(marker), false);
  }
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /not signature verification or production admission/);
});

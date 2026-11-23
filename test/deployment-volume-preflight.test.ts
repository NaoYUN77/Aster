import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeploymentVolumePreflightError, preflightDeploymentVolumes } from "../src/deployment-volume-preflight.js";

const posix = process.platform !== "win32";
const root = posix && process.getuid?.() === 0;
const cli = fileURLToPath(new URL(`../src/deployment-volume-preflight.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
const marker = "DO_NOT_PRINT_SYNTHETIC_DATABASE_VALUE";
function errorCode(code: string) {
  return (error: unknown) => error instanceof DeploymentVolumePreflightError && error.code === code;
}
function runCli(args: string[]) {
  return spawnSync(process.execPath, [...(cli.endsWith(".ts") ? ["--import", "tsx"] : []), cli, ...args], { encoding: "utf8", timeout: 15_000 });
}
function update(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}
async function snapshot(path: string): Promise<unknown> {
  const entries = await readdir(path);
  return Promise.all(entries.sort().map(async (name) => {
    const child = join(path, name);
    const stat = await lstat(child);
    return [name, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.isDirectory() ? await snapshot(child) : createHash("sha256").update(await readFile(child)).digest("hex")];
  }));
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await mkdtemp(join(tmpdir(), "aster-volume-preflight-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const appVolume = join(parent, "app");
  await mkdir(appVolume, { mode: 0o755 });
  const webDb = join(appVolume, "web.sqlite");
  const agentDb = join(appVolume, "agent.sqlite");
  update(webDb, `CREATE TABLE requests(id TEXT PRIMARY KEY, text TEXT); INSERT INTO requests VALUES('synthetic', '${marker}');`);
  update(agentDb, "CREATE TABLE synthetic_agent_state(id INTEGER PRIMARY KEY)");
  await chown(appVolume, 1000, 1000);
  for (const path of [agentDb, webDb]) {
    await chown(path, 1000, 1000);
    await chmod(path, 0o600);
  }
  return { parent, appVolume, webDb, agentDb, options: { appVolume } };
}

// Ownership is part of the real contract, so these fixtures require POSIX root to assign
// the service UID. Run the compiled file in the Linux app image as root to exercise them.
const integration = { skip: !root };

test("app metadata succeeds without changing bytes, modes, mtime or directory entries", integration, async (t) => {
  const { parent, options, agentDb } = await fixture(t);
  update(agentDb, "PRAGMA journal_mode=WAL");
  const before = await snapshot(parent);
  assert.deepEqual(await preflightDeploymentVolumes(options), {
    status: "offline-volume-metadata-ok", code: "VOLUME_METADATA_OK", productionAdmission: "not-evaluated",
  });
  assert.deepEqual(await snapshot(parent), before);
  const result = runCli(["--app-volume", options.appVolume]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).productionAdmission, "not-evaluated");
  assert.equal((result.stdout + result.stderr).includes(marker), false);
  assert.deepEqual(await snapshot(parent), before);
});

test("wrong owners and unsafe or owner-inaccessible modes fail even when the operator is root", integration, async (t) => {
  const { options, appVolume, agentDb } = await fixture(t);
  await chown(appVolume, 0, 0);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("VOLUME_OWNER_MISMATCH"));
  await chown(appVolume, 1000, 1000);
  await chmod(appVolume, 0o777);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("VOLUME_MODE_UNSAFE"));
  await chmod(appVolume, 0o755);
  await chown(agentDb, 0, 0);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_OWNER_MISMATCH"));
  await chown(agentDb, 1000, 1000);
  // The app databases are not confidential: group/other write bits or a missing owner
  // write bit are unsafe, while plain group/other read (0o644) is acceptable for them.
  for (const mode of [0o622, 0o400, 0o000]) {
    await chmod(agentDb, mode);
    await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_MODE_UNSAFE"));
  }
  await chmod(agentDb, 0o600);
});

test("missing or uninitialized app DB and corrupt web DB fail closed", integration, async (t) => {
  const { options, webDb, agentDb } = await fixture(t);
  await writeFile(webDb, "");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("SQLITE_NOT_INITIALIZED"));
  await rm(webDb);
  // Missing web.sqlite is allowed when agent.sqlite is initialized.
  assert.equal((await preflightDeploymentVolumes(options)).code, "VOLUME_METADATA_OK");
  await writeFile(agentDb, "");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("SQLITE_NOT_INITIALIZED"));
  await rm(agentDb);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_UNREADABLE"));
});

test("symlinks, directories, FIFOs and oversized regular database files never reach SQLite", integration, async (t) => {
  const { options, agentDb, parent } = await fixture(t);
  await rm(agentDb);
  await mkdir(agentDb);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_NOT_REGULAR_FILE"));
  await rm(agentDb, { recursive: true });
  const other = join(parent, "synthetic-target");
  await writeFile(other, marker);
  await symlink(other, agentDb);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("SYMLINK_NOT_ALLOWED"));
  await rm(agentDb);
  const result = spawnSync("mkfifo", [agentDb]);
  assert.equal(result.status, 0);
  await chown(agentDb, 1000, 1000);
  await chmod(agentDb, 0o600);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_NOT_REGULAR_FILE"));
  await rm(agentDb);
  const file = await open(agentDb, "w", 0o600);
  await file.truncate(1024 * 1024 * 1024 + 1);
  await file.close();
  await chown(agentDb, 1000, 1000);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_TOO_LARGE"));
});

test("WAL on writable mount and nonempty rollback journals are rejected without opening or deleting them", integration, async (t) => {
  const { options, agentDb, parent } = await fixture(t);
  for (const suffix of ["-wal", "-journal"]) {
    const path = `${agentDb}${suffix}`;
    await writeFile(path, marker, { mode: 0o600 });
    await chown(path, 1000, 1000);
    const before = await snapshot(parent);
    await assert.rejects(preflightDeploymentVolumes(options), errorCode("SQLITE_OFFLINE_STATE_REQUIRED"));
    assert.deepEqual(await snapshot(parent), before);
    await rm(path);
  }
});

// Opt in after npm run build with ASTER_TEST_DOCKER_VOLUME_PREFLIGHT=1. This fixture
// uses a unique Docker volume, a pinned local runtime tag, no network and no production mounts.
test("Docker read-only residual WAL is read and all source files remain unchanged", {
  skip: process.env.ASTER_TEST_DOCKER_VOLUME_PREFLIGHT !== "1",
}, () => {
  const volume = `aster-preflight-wal-test-${randomUUID()}`;
  const image = process.env.ASTER_VOLUME_TEST_IMAGE ?? "node:24.19.0-bookworm-slim";
  const dist = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/" : "../", import.meta.url));
  function docker(args: string[], expected = 0) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, expected, result.stderr);
    return result;
  }
  const mount = `type=volume,source=${volume},target=/fixture`;
  const create = `
    import {mkdirSync,chmodSync,chownSync} from 'node:fs';
    import {DatabaseSync} from 'node:sqlite';
    mkdirSync('/fixture/app'); chownSync('/fixture/app',1000,1000); chmodSync('/fixture/app',0o755);
    function create(p,sql) {const d=new DatabaseSync(p);d.exec(sql);d.close();chownSync(p,1000,1000);chmodSync(p,0o600);}
    create('/fixture/app/agent.sqlite','CREATE TABLE state(id INTEGER PRIMARY KEY)');
    create('/fixture/app/web.sqlite','CREATE TABLE requests(id TEXT PRIMARY KEY)');
  `;
  const crash = () => {
    const writer = `
      import {chmodSync,chownSync} from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
      const p='/fixture/app/web.sqlite'; const d=new DatabaseSync(p);
      d.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO requests VALUES('synthetic')");
      for(const s of ['-wal','-shm']) {chownSync(p+s,1000,1000);chmodSync(p+s,0o600);}
      process.kill(process.pid,'SIGKILL');
    `;
    // A container's PID 1 has special signal semantics, so kill a writer child.
    return `import {spawnSync} from 'node:child_process';
      const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(writer)}]);
      if(child.signal!=='SIGKILL') throw Error('synthetic writer was not killed');
      process.exit(137);`;
  };
  const snapshotScript = `
    import {readdirSync,lstatSync,readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
    function snap(p) {return readdirSync(p).sort().map(n=>{const f=p+'/'+n,s=lstatSync(f);return [n,s.uid,s.mode,s.size,s.mtimeMs,s.isDirectory()?snap(f):createHash('sha256').update(readFileSync(f)).digest('hex')];});}
    console.log(JSON.stringify(snap('/fixture')));
  `;
  function execute(script: string, readonly = false, expected = 0) {
    return docker(["run", "--rm", "--pull", "never", "--network", "none", "--user", "0:0", ...(readonly ? ["--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE"] : []),
      "--mount", `${mount}${readonly ? ",readonly" : ""}`, image, "node", "--input-type=module", "-e", script], expected);
  }
  function probe(expected: number) {
    return docker(["run", "--rm", "--pull", "never", "--network", "none", "--user", "0:0", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE",
      "--mount", `${mount},readonly`, "--mount", `type=bind,source=${dist},target=/probe,readonly`, image,
      "node", "/probe/src/deployment-volume-preflight.js", "--app-volume", "/fixture/app"], expected);
  }
  docker(["volume", "create", volume]);
  try {
    execute(create);
    execute(crash(), false, 137);
    const cleanBefore = execute(snapshotScript, true).stdout;
    assert.equal(JSON.parse(probe(0).stdout).code, "VOLUME_METADATA_OK");
    assert.equal(execute(snapshotScript, true).stdout, cleanBefore);
  } finally {
    docker(["volume", "rm", volume]);
  }
});

test("CLI sanitizes corrupt DB and raw arguments; all failures preserve not-evaluated", async (t) => {
  for (const args of [[], [marker], ["--unknown", marker], ["--app-volume", marker, "--app-volume", marker]]) {
    const result = runCli(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal((result.stdout + result.stderr).includes(marker), false);
    assert.equal(JSON.parse(result.stderr).productionAdmission, "not-evaluated");
  }
  if (root) {
    const { options, agentDb } = await fixture(t);
    await writeFile(agentDb, marker);
    const result = runCli(["--app-volume", options.appVolume]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { status: "offline-volume-metadata-failed", code: "SQLITE_UNREADABLE", productionAdmission: "not-evaluated" });
    assert.equal((result.stdout + result.stderr).includes(marker), false);
  }
});

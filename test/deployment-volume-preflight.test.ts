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
const ddl = `CREATE TABLE master_key (
  id INTEGER PRIMARY KEY CHECK (id = 1), sentinel BLOB NOT NULL, sentinel_nonce BLOB NOT NULL,
  dek_ciphertext BLOB, dek_nonce BLOB, dek_plaintext BLOB, salt BLOB,
  kdf_time INTEGER, kdf_memory INTEGER, kdf_threads INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
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
  const brokerVolume = join(parent, "broker");
  const vault = join(brokerVolume, ".agent-vault");
  await mkdir(appVolume, { mode: 0o755 });
  await mkdir(brokerVolume, { mode: 0o755 });
  await mkdir(vault, { mode: 0o700 });
  const brokerDb = join(vault, "agent-vault.db");
  const inboxDb = join(appVolume, "inbox.sqlite");
  const agentDb = join(appVolume, "agent.sqlite");
  update(brokerDb, `${ddl}; INSERT INTO master_key
    (id,sentinel,sentinel_nonce,dek_ciphertext,dek_nonce,dek_plaintext,salt,kdf_time,kdf_memory,kdf_threads)
    VALUES(1,zeroblob(44),zeroblob(12),zeroblob(48),zeroblob(12),NULL,zeroblob(16),3,65536,4)`);
  update(inboxDb, `
    CREATE TABLE checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);
    CREATE TABLE identity(id INTEGER PRIMARY KEY CHECK(id=1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
    CREATE TABLE inbox(requestId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT, receivedAt TEXT, repliedAt TEXT);
    CREATE TABLE deliveries(requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
      part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      messageId TEXT, error TEXT, createdAt TEXT, updatedAt TEXT, PRIMARY KEY(requestId,part));
    CREATE TABLE failures(requestId TEXT PRIMARY KEY REFERENCES inbox(requestId), code TEXT NOT NULL);
    INSERT INTO checkpoint VALUES(1,0);
    INSERT INTO inbox(requestId,conversationId,senderId,text,status) VALUES('synthetic','conversation','sender','${marker}','ready');
    INSERT INTO deliveries(requestId,part,text,status) VALUES('synthetic',0,'${marker}','pending');
  `);
  update(agentDb, "CREATE TABLE synthetic_agent_state(id INTEGER PRIMARY KEY)");
  await Promise.all([chown(appVolume, 1000, 1000), chown(brokerVolume, 65532, 65532), chown(vault, 65532, 65532)]);
  for (const [path, uid] of [[brokerDb, 65532], [agentDb, 1000], [inboxDb, 1000]] as const) {
    await chown(path, uid, uid);
    await chmod(path, 0o600);
  }
  return { parent, appVolume, brokerVolume, vault, brokerDb, inboxDb, agentDb, options: { appVolume, brokerVolume, inboxDiagnostics: true } };
}

// Ownership is part of the real contract, so these fixtures require POSIX root to assign
// both service UIDs. Run the compiled file in the Linux app image as root to exercise them.
const integration = { skip: !root };

test("wrapped metadata and bounded inbox counts succeed without changing bytes, modes, mtime or directory entries", integration, async (t) => {
  const { parent, options, brokerDb } = await fixture(t);
  update(brokerDb, "PRAGMA journal_mode=WAL");
  const before = await snapshot(parent);
  assert.deepEqual(await preflightDeploymentVolumes(options), {
    status: "offline-volume-metadata-ok", code: "VOLUME_METADATA_OK", productionAdmission: "not-evaluated",
    inbox: { requests: 1, deliveryParts: 1, sending: 0, uncertain: 0, failed: 0 },
  });
  assert.deepEqual(await snapshot(parent), before);
  const result = runCli(["--app-volume", options.appVolume, "--broker-volume", options.brokerVolume, "--inbox-diagnostics"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).productionAdmission, "not-evaluated");
  assert.equal((result.stdout + result.stderr).includes(marker), false);
  assert.deepEqual(await snapshot(parent), before);
});

test("plaintext DEK is rejected including empty BLOB, text, and hybrid wrapped/plaintext rows", integration, async (t) => {
  const { options, brokerDb } = await fixture(t);
  for (const value of ["zeroblob(32)", "zeroblob(0)", "''", `'${marker}'`]) {
    update(brokerDb, `UPDATE master_key SET dek_plaintext = ${value}`);
    await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_PLAINTEXT_DEK"));
  }
});

test("wrapped fields require pinned SQL storage types, exact lengths and KDF metadata", integration, async (t) => {
  const { options, brokerDb } = await fixture(t);
  for (const change of [
    "dek_ciphertext = NULL", "dek_ciphertext = zeroblob(47)", "dek_ciphertext = printf('%048d',0)",
    "dek_nonce = zeroblob(11)", "sentinel = zeroblob(43)", "sentinel_nonce = zeroblob(13)",
    "salt = zeroblob(15)", "kdf_time = 0", "kdf_memory = 65535", "kdf_threads = 5",
  ]) {
    update(brokerDb, `UPDATE master_key SET ${change}`);
    await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_WRAPPED_DEK_INVALID"));
    update(brokerDb, "UPDATE master_key SET sentinel=zeroblob(44),sentinel_nonce=zeroblob(12),dek_ciphertext=zeroblob(48),dek_nonce=zeroblob(12),salt=zeroblob(16),kdf_time=3,kdf_memory=65536,kdf_threads=4");
  }
});

test("unknown master schema, a view, missing or multiple records fail closed", integration, async (t) => {
  const { options, brokerDb } = await fixture(t);
  update(brokerDb, "ALTER TABLE master_key ADD COLUMN future_field BLOB");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_SCHEMA_UNKNOWN"));
  update(brokerDb, "ALTER TABLE master_key DROP COLUMN future_field; DELETE FROM master_key");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_MASTER_KEY_MISSING"));
  update(brokerDb, "DROP TABLE master_key; CREATE VIEW master_key AS SELECT 1 AS id");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_SCHEMA_UNKNOWN"));
  update(brokerDb, `DROP VIEW master_key; ${ddl.replace(" CHECK (id = 1)", "")}; INSERT INTO master_key(id,sentinel,sentinel_nonce) VALUES(1,zeroblob(44),zeroblob(12)),(2,zeroblob(44),zeroblob(12))`);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("BROKER_SCHEMA_UNKNOWN"));
});

test("wrong owners and unsafe or owner-inaccessible modes fail even when the operator is root", integration, async (t) => {
  const { options, appVolume, brokerDb, vault, agentDb } = await fixture(t);
  await chown(appVolume, 0, 0);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("VOLUME_OWNER_MISMATCH"));
  await chown(appVolume, 1000, 1000);
  await chmod(appVolume, 0o777);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("VOLUME_MODE_UNSAFE"));
  await chmod(appVolume, 0o755);
  await chmod(vault, 0o755);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("VOLUME_MODE_UNSAFE"));
  await chmod(vault, 0o700);
  await chown(brokerDb, 1000, 1000);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_OWNER_MISMATCH"));
  await chown(brokerDb, 65532, 65532);
  for (const mode of [0o644, 0o400, 0o000]) {
    await chmod(brokerDb, mode);
    await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_MODE_UNSAFE"));
  }
  await chmod(brokerDb, 0o600);
  await chmod(agentDb, 0o666);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_MODE_UNSAFE"));
});

test("pre-recovery sending and uncertain deliveries and legacy uncertain requests are reported without mutation", integration, async (t) => {
  const { parent, options, inboxDb } = await fixture(t);
  for (const state of ["sending", "uncertain", "failed"] as const) {
    update(inboxDb, `UPDATE deliveries SET status='${state}',error='${marker}'`);
    const before = await snapshot(parent);
    const result = await preflightDeploymentVolumes(options);
    assert.equal(result.status, "offline-volume-metadata-ok");
    assert.equal(result.productionAdmission, "not-evaluated");
    assert.deepEqual(result.inbox, {
      requests: 1, deliveryParts: 1,
      sending: state === "sending" ? 1 : 0,
      uncertain: state === "uncertain" ? 1 : 0,
      failed: state === "failed" ? 1 : 0,
    });
    assert.deepEqual(await snapshot(parent), before);
  }
  update(inboxDb, "UPDATE deliveries SET status='pending'; UPDATE inbox SET status='uncertain'");
  const before = await snapshot(parent);
  assert.deepEqual((await preflightDeploymentVolumes(options)).inbox, {
    requests: 1, deliveryParts: 1, sending: 0, uncertain: 0, failed: 0,
  });
  assert.deepEqual(await snapshot(parent), before);
});

test("missing initialized app DB and unknown diagnostic status/schema fail closed", integration, async (t) => {
  const { options, inboxDb, agentDb } = await fixture(t);
  update(inboxDb, "UPDATE deliveries SET status='future-state'");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("APP_SCHEMA_UNKNOWN"));
  update(inboxDb, "DROP TABLE failures");
  await assert.rejects(preflightDeploymentVolumes({ ...options, inboxDiagnostics: false }), errorCode("APP_SCHEMA_UNKNOWN"));
  await writeFile(agentDb, "");
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("SQLITE_NOT_INITIALIZED"));
  await rm(agentDb);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("STATE_UNREADABLE"));
});

test("bounded diagnostic queries reject oversized inboxes without reading message content", integration, async (t) => {
  const { options, inboxDb } = await fixture(t);
  update(inboxDb, `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100001)
    INSERT INTO deliveries(requestId,part,text,status) SELECT 'synthetic',i,'${marker}','sent' FROM n`);
  await assert.rejects(preflightDeploymentVolumes(options), errorCode("APP_DIAGNOSTICS_LIMIT"));
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
test("Docker read-only residual WAL is read, plaintext only in WAL is rejected, and all source files remain unchanged", {
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
    for(const [p,u,m] of [['/fixture/app',1000,0o755],['/fixture/broker',65532,0o755],['/fixture/broker/.agent-vault',65532,0o700]]) {
      mkdirSync(p); chownSync(p,u,u); chmodSync(p,m);
    }
    function create(p,sql,u) {const d=new DatabaseSync(p);d.exec(sql);d.close();chownSync(p,u,u);chmodSync(p,0o600);}
    create('/fixture/app/agent.sqlite','CREATE TABLE state(id INTEGER PRIMARY KEY)',1000);
    create('/fixture/app/inbox.sqlite','CREATE TABLE checkpoint(id INTEGER); CREATE TABLE identity(id INTEGER); CREATE TABLE inbox(status TEXT); CREATE TABLE deliveries(status TEXT); CREATE TABLE failures(code TEXT)',1000);
    create('/fixture/broker/.agent-vault/agent-vault.db',${JSON.stringify(`${ddl}; INSERT INTO master_key(id,sentinel,sentinel_nonce,dek_ciphertext,dek_nonce,dek_plaintext,salt,kdf_time,kdf_memory,kdf_threads) VALUES(1,zeroblob(44),zeroblob(12),zeroblob(48),zeroblob(12),NULL,zeroblob(16),3,65536,4)`)},65532);
  `;
  const crash = (plaintext: boolean) => {
    const writer = `
      import {chmodSync,chownSync} from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
      const p='/fixture/broker/.agent-vault/agent-vault.db'; const d=new DatabaseSync(p);
      d.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE master_key SET ${plaintext ? "dek_plaintext=zeroblob(32)" : "created_at='synthetic-wal-commit'"}");
      for(const s of ['-wal','-shm']) {chownSync(p+s,65532,65532);chmodSync(p+s,0o600);}
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
      "node", "/probe/src/deployment-volume-preflight.js", "--app-volume", "/fixture/app", "--broker-volume", "/fixture/broker", "--inbox-diagnostics"], expected);
  }
  docker(["volume", "create", volume]);
  try {
    execute(create);
    execute(crash(false), false, 137);
    const wrappedBefore = execute(snapshotScript, true).stdout;
    assert.equal(JSON.parse(probe(0).stdout).code, "VOLUME_METADATA_OK");
    assert.equal(execute(snapshotScript, true).stdout, wrappedBefore);
    execute(crash(true), false, 137);
    const plaintextBefore = execute(snapshotScript, true).stdout;
    const result = probe(1);
    assert.deepEqual(JSON.parse(result.stderr), {
      status: "offline-volume-metadata-failed", code: "BROKER_PLAINTEXT_DEK", productionAdmission: "not-evaluated",
    });
    assert.equal(execute(snapshotScript, true).stdout, plaintextBefore);
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
    const { options, brokerDb } = await fixture(t);
    await writeFile(brokerDb, marker);
    const result = runCli(["--app-volume", options.appVolume, "--broker-volume", options.brokerVolume]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { status: "offline-volume-metadata-failed", code: "SQLITE_UNREADABLE", productionAdmission: "not-evaluated" });
    assert.equal((result.stdout + result.stderr).includes(marker), false);
  }
});

import { createSecureContext } from "node:tls";
import { ConfigurationError } from "../errors.js";
import { describeRpcAgentConfig, readRpcAgentConfig, readTlsMaterial } from "./rpc-config.js";
import { startRpcAgent } from "./rpc-server.js";
import { PtcSandboxManager, type PtcPreflightResult } from "./ptc-sandbox.js";
import { listenTlsRpc, listenUnixRpc, type RpcServer } from "./rpc-transport.js";

const USAGE = `Usage: node dist/src/execution/rpc-main.js [--check]

Reads EXECUTION_AGENT_* from the environment. --check validates the bind address, limits, TLS
material, and (with EXECUTION_AGENT_PTC=1) the local PTC sandbox without listening or executing
anything; it exits nonzero when a required capability is missing. TCP mode requires a private or
loopback IP and mutual TLS; Unix mode is intended for local tests or same-host deployments.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = readRpcAgentConfig();
  const check = process.argv.includes("--check");
  // PTC preflight only inspects the host: files, user namespaces, cgroup v2, and prlimit.
  const sandbox = config.ptc === undefined ? undefined : new PtcSandboxManager(config.ptc);
  const ptcPreflight: PtcPreflightResult | undefined = sandbox === undefined
    ? undefined
    : await sandbox.preflight();
  if (check) {
    if (config.transport === "tls") {
      if (config.certPath === undefined || config.keyPath === undefined || config.caPath === undefined) {
        throw new ConfigurationError("TCP mode requires EXECUTION_AGENT_TLS_CERT_PATH, EXECUTION_AGENT_TLS_KEY_PATH, and EXECUTION_AGENT_TLS_CA_PATH");
      }
      const material = await readTlsMaterial({
        certPath: config.certPath,
        keyPath: config.keyPath,
        caPath: config.caPath,
      });
      createSecureContext({ cert: material.cert, key: material.key, ca: material.ca });
    }
    const summary = {
      ...describeRpcAgentConfig(config),
      ...(ptcPreflight === undefined ? {} : { ptcPreflight }),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (ptcPreflight !== undefined && !ptcPreflight.ok) process.exitCode = 1;
    return;
  }
  if (ptcPreflight !== undefined && !ptcPreflight.ok) {
    throw new ConfigurationError(
      `PTC sandbox preflight failed: ${ptcPreflight.diagnostics.join("; ") || "unspecified"}`,
    );
  }
  let server: RpcServer;
  let transport: "unix" | "tls" = config.transport;
  if (config.transport === "unix") {
    if (config.socketPath === undefined) throw new ConfigurationError("EXECUTION_AGENT_UNIX_SOCKET is required");
    server = await listenUnixRpc(config.socketPath, {
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
  } else {
    if (config.bind === undefined || config.port === undefined
      || config.certPath === undefined || config.keyPath === undefined || config.caPath === undefined
      || config.clientCertName === undefined) {
      throw new ConfigurationError("TCP mode requires EXECUTION_AGENT_BIND, EXECUTION_AGENT_PORT, and TLS paths");
    }
    const material = await readTlsMaterial({
      certPath: config.certPath,
      keyPath: config.keyPath,
      caPath: config.caPath,
    });
    // Fail before listening if a PEM file is unreadable or does not form a usable context.
    createSecureContext({ cert: material.cert, key: material.key, ca: material.ca });
    server = await listenTlsRpc({
      host: config.bind,
      port: config.port,
      cert: material.cert,
      key: material.key,
      ca: material.ca,
      requireClientCert: true,
      allowedClientNames: [config.clientCertName],
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
    transport = "tls";
  }
  const agent = startRpcAgent({
    server,
    executionId: config.executionId,
    transport,
    maxSessions: config.maxSessions,
    maxConcurrent: config.maxConcurrent,
    sessionTtlMs: config.sessionTtlMs,
    heartbeatMs: config.heartbeatMs,
    testExecutorEnabled: config.testExecutorEnabled,
    ...(sandbox === undefined ? {} : { ptc: sandbox }),
  });
  const address = server.address();
  const target = "path" in address ? address.path : `${address.host}:${address.port}`;
  const ptcNote = ptcPreflight === undefined
    ? ""
    : `; PTC ${ptcPreflight.isolation.mode} cgroup=${ptcPreflight.isolation.cgroup} network=${ptcPreflight.isolation.network}`;
  console.info(`Execution agent listening on ${transport} ${target}; executionId ${config.executionId}${ptcNote}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    agent.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  // Operator-facing messages are limited to configuration errors. TLS/library errors may contain
  // paths or other host details, so they are reported with a fixed code only.
  console.error("Execution agent stopped:",
    error instanceof ConfigurationError ? error.message : "AGENT_FAILED");
  process.exitCode = 1;
}

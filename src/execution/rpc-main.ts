import { createSecureContext } from "node:tls";
import { ConfigurationError } from "../errors.js";
import { describeRpcAgentConfig, readRpcAgentConfig, readTlsMaterial } from "./rpc-config.js";
import { probePtcRuntime } from "./ptc-cgroup.js";
import { readPtcConfig } from "./ptc-config.js";
import { PtcExecutor } from "./ptc-executor.js";
import { startRpcAgent } from "./rpc-server.js";
import { listenTlsRpc, listenUnixRpc, type RpcServer } from "./rpc-transport.js";

const USAGE = `Usage: node dist/src/execution/rpc-main.js [--check]

Reads EXECUTION_AGENT_* from the environment. --check validates the bind address, limits, and
TLS material without listening or executing anything. TCP mode requires a private or loopback IP
and mutual TLS; Unix mode is intended for local tests or same-host deployments.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = readRpcAgentConfig();
  const ptcConfig = readPtcConfig();
  let ptc: PtcExecutor | undefined;
  let ptcChecks: Record<string, boolean | null> | undefined;
  if (ptcConfig !== undefined) {
    const probe = await probePtcRuntime(ptcConfig);
    ptc = new PtcExecutor({ config: ptcConfig, probe });
    ptcChecks = await ptc.preflight();
  }
  const checkReport = (): string => `${JSON.stringify({
    ...describeRpcAgentConfig(config),
    ...(ptcChecks === undefined ? {} : { ptc: ptcChecks }),
  }, null, 2)}\n`;
  let server: RpcServer;
  let transport: "unix" | "tls" = config.transport;
  if (config.transport === "unix") {
    if (config.socketPath === undefined) throw new ConfigurationError("EXECUTION_AGENT_UNIX_SOCKET is required");
    if (process.argv.includes("--check")) {
      process.stdout.write(checkReport());
      return;
    }
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
    if (process.argv.includes("--check")) {
      process.stdout.write(checkReport());
      return;
    }
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
  if (ptc !== undefined && !ptc.enabled) {
    // Refusing to listen is the only fail-closed answer: a host that cannot isolate must not
    // advertise the Phase 1 surface at all.
    throw new ConfigurationError(
      "PTC is enabled but this host cannot provide bwrap, user namespaces and cgroup v2 (or an explicitly allowed degraded fallback)",
    );
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
    ...(ptc === undefined ? {} : { ptc }),
  });
  const address = server.address();
  const target = "path" in address ? address.path : `${address.host}:${address.port}`;
  console.info(`Execution agent listening on ${transport} ${target}; executionId ${config.executionId}`);
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

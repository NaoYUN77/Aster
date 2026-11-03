import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { test } from "node:test";
import { startRpcGateway } from "../src/execution/rpc-gateway.js";

// The gateway socket is a filesystem Unix socket, exactly as in production; Windows named pipes
// have different lifecycle rules, so those cases run on POSIX CI only.
const posix = process.platform !== "win32";

async function temporarySocket(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aster-rpc-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "gateway.sock");
}

async function startEchoUpstream(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

function upstreamConnector(port: number): () => Promise<Duplex> {
  return () => new Promise<Duplex>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function openClient(socketPath: string): Promise<Socket> {
  const client = connect(socketPath);
  client.on("error", () => undefined);
  await once(client, "connect");
  return client;
}

test("the gateway relays bytes between the app socket and the upstream", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const { port, server } = await startEchoUpstream();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const gateway = await startRpcGateway({ socketPath, maxConnections: 4, connectUpstream: upstreamConnector(port) });
  t.after(() => gateway.close());

  const client = await openClient(socketPath);
  t.after(() => client.destroy());
  client.write("ping");
  const [data] = await once(client, "data") as [Buffer];
  assert.equal(data.toString(), "ping");
  client.write("pong");
  const [second] = await once(client, "data") as [Buffer];
  assert.equal(second.toString(), "pong");
});

test("a connection beyond the limit is closed without reaching the upstream", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const { port, server } = await startEchoUpstream();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const gateway = await startRpcGateway({ socketPath, maxConnections: 1, connectUpstream: upstreamConnector(port) });
  t.after(() => gateway.close());

  const first = await openClient(socketPath);
  t.after(() => first.destroy());
  first.write("first");
  const [echo] = await once(first, "data") as [Buffer];
  assert.equal(echo.toString(), "first");

  const second = await openClient(socketPath);
  second.on("error", () => undefined);
  second.write("second");
  await once(second, "close");

  // The rejected connection must not have displaced the first tunnel.
  first.write("still-here");
  const [again] = await once(first, "data") as [Buffer];
  assert.equal(again.toString(), "still-here");
});

test("an upstream failure closes the app connection", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const gateway = await startRpcGateway({
    socketPath,
    maxConnections: 2,
    connectUpstream: async () => Promise.reject(new Error("upstream refused")),
  });
  t.after(() => gateway.close());

  const client = await openClient(socketPath);
  client.on("error", () => undefined);
  client.write("hello");
  await once(client, "close");
});

test("close removes the socket and a second start can reuse the path", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const first = await startRpcGateway({
    socketPath,
    maxConnections: 1,
    connectUpstream: async () => new PassThrough() as Duplex,
  });
  await first.close();
  await assert.rejects(access(socketPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const second = await startRpcGateway({
    socketPath,
    maxConnections: 1,
    connectUpstream: async () => new PassThrough() as Duplex,
  });
  t.after(() => second.close());
  await access(socketPath);
});

test("a regular file at the socket path is never deleted", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  await writeFile(socketPath, "do not delete");
  await assert.rejects(
    startRpcGateway({ socketPath, maxConnections: 1, connectUpstream: async () => Promise.reject(new Error("unused")) }),
    /refusing to replace a non-socket/,
  );
  assert.equal(await readFile(socketPath, "utf8"), "do not delete");
});

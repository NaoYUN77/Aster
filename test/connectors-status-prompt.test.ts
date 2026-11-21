import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorService } from "../src/connectors/service.js";
import type { ConnectorConnection, ConnectorDefinition } from "../src/connectors/store.js";
import { connectorStatusText, createConnectorExtension } from "../src/connectors/tools.js";

const DEFINITIONS: ConnectorDefinition[] = [
  {
    provider: "github",
    displayName: "GitHub",
    transport: "oauth",
    defaultScopes: ["read:user"],
    tools: ["connector_github_list_repositories", "connector_github_list_issues"],
  },
  { provider: "gmail", displayName: "Gmail", transport: "oauth", defaultScopes: [], tools: [] },
];

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: "connection-1",
    provider: "github",
    slug: "gh-demo",
    ownerId: "owner",
    status: "connected",
    accountLabel: "demo-user",
    scopes: ["read:user"],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:01.000Z",
    lastErrorCode: null,
    ...overrides,
  };
}

test("the connector section names authorized tools and says so when nothing is connected", async () => {
  const state: { connections: ConnectorConnection[] } = { connections: [] };
  const service = {
    list: () => ({ definitions: DEFINITIONS, connections: state.connections }),
  } as unknown as ConnectorService;

  assert.equal(connectorStatusText(service), "暂无已授权连接。");

  state.connections = [connection()];
  const text = connectorStatusText(service);
  assert.match(text, /已授权连接/);
  assert.match(text, /gh-demo \(github, connected, demo-user\)：可用工具 connector_github_list_repositories, connector_github_list_issues/);

  state.connections = [connection({ provider: "gmail", slug: "mail", accountLabel: "me@example.test" })];
  assert.match(connectorStatusText(service), /mail \(gmail, connected, me@example\.test\)：已连接（无内置工具）/);

  state.connections = [connection({ status: "error", lastErrorCode: "CONNECTOR_AUTH_EXPIRED" })];
  assert.match(connectorStatusText(service), /gh-demo \(github, error, demo-user\)：工具暂不可用/);

  state.connections = [connection({ status: "revoked" })];
  assert.match(connectorStatusText(service), /revoked/);
});

test("the section is re-rendered per request, so status changes need no restart", async () => {
  const state: { connections: ConnectorConnection[] } = { connections: [connection()] };
  const service = {
    list: () => ({ definitions: DEFINITIONS, connections: state.connections }),
  } as unknown as ConnectorService;
  const extension = createConnectorExtension(service, "owner");
  const section = extension.sections?.[0];
  assert.ok(section !== undefined);
  const render = section.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined> | string | undefined;

  assert.match(String(await render({}, {})), /可用工具 connector_github_list_repositories/);

  // The OAuth completion/disconnect path mutates the same store the section reads.
  state.connections = [connection({ status: "revoked", accountLabel: null })];
  const revoked = String(await render({}, {}));
  assert.match(revoked, /工具暂不可用/);
  assert.equal(revoked.includes("可用工具 connector_github"), false);

  state.connections = [];
  assert.equal(String(await render({}, {})), "暂无已授权连接。");
});

test("connector_list remains registered as the authoritative query", () => {
  const service = { list: () => ({ definitions: DEFINITIONS, connections: [] }) } as unknown as ConnectorService;
  const extension = createConnectorExtension(service, "owner");
  const names = (extension.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes("connector_list"));
  assert.ok(names.includes("connector_github_list_repositories"));
});

test("a failing status read degrades to a neutral line instead of breaking the turn", () => {
  const service = {
    list: () => {
      throw new Error("database closed");
    },
  } as unknown as ConnectorService;
  assert.equal(connectorStatusText(service), "连接器状态暂不可用。");
});

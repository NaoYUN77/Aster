import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const CONTRACT = join(process.cwd(), "docs/api/three-client-v1.openapi.yaml");

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing contract section: ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
}

test("the connector contract documents the routes and fields the server implements", async () => {
  const contract = await readFile(CONTRACT, "utf8");

  const connectors = sliceBetween(contract, "  /api/v1/connectors:\n", "  /api/v1/connectors/{slug}");
  assert.match(connectors, /operationId: listConnectors/);
  assert.match(connectors, /operationId: createConnector/);
  assert.match(connectors, /ConnectorListResponse/);
  assert.match(connectors, /CreateConnectorResponse/);

  const disconnect = sliceBetween(contract, "  /api/v1/connectors/{slug}:\n", "  /api/v1/connectors/{slug}/oauth/start:");
  assert.match(disconnect, /operationId: disconnectConnector/);
  assert.match(disconnect, /"204":/);
  assert.match(disconnect, /"404":/);
  assert.match(disconnect, /CONNECTOR_NOT_FOUND/);
  assert.match(disconnect, /"503":/);
  assert.match(disconnect, /CONNECTORS_DISABLED/);
  assert.match(disconnect, /connector\.changed/);
  assert.match(disconnect, /revoked/);

  const oauthStart = sliceBetween(contract, "  /api/v1/connectors/{slug}/oauth/start:\n", "  /api/v1/connectors/oauth/callback:");
  assert.match(oauthStart, /"404":/);
  assert.match(oauthStart, /OAuthStartResponse/);

  // Provider shapes the client generates types from.
  const providerSchema = sliceBetween(contract, "    ConnectorDefinition:\n", "    ConnectorConnection:\n");
  for (const field of ["provider", "displayName", "transport", "defaultScopes", "tools"]) {
    assert.match(providerSchema, new RegExp(`^        ${field}:`, "m"), `missing provider field ${field}`);
  }
  const connectionSchema = sliceBetween(contract, "    ConnectorConnection:\n", "    ConnectorListResponse:\n");
  for (const field of [
    "id", "provider", "slug", "status", "accountLabel", "scopes", "createdAt", "updatedAt", "lastErrorCode",
  ]) {
    assert.match(connectionSchema, new RegExp(`^        ${field}:`, "m"), `missing connection field ${field}`);
  }
  const statusSchema = sliceBetween(contract, "    ConnectorStatus:\n", "    ConnectorDefinition:\n");
  assert.match(statusSchema, /enum: \[pending, connected, error, revoked\]/);

  // Server-side OAuth setup the native clients cannot infer.
  for (const secret of [
    "github_client_id", "github_client_secret", "google_client_id", "google_client_secret", "credential_master_key",
  ]) {
    assert.ok(contract.includes(`\`${secret}\``), `missing secret documentation for ${secret}`);
  }
  assert.ok(contract.includes("{CONNECTOR_OAUTH_REDIRECT_BASE}/api/v1/connectors/oauth/callback"));
});

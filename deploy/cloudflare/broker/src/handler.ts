import { authenticate } from "./auth";
import { aadFor, decryptCredential, encryptCredential, parseMasterKey } from "./crypto";
import { BrokerError, brokerError, emptyResponse, jsonResponse } from "./errors";
import { needsRefresh, refreshAccessToken, type FetchLike } from "./refresh";
import type { Env, Provider, StoredTokens, VaultRecord, VaultRpc } from "./types";
import { connectionInput, connectionSlug, readJsonObject, secretName, storedTokens } from "./validate";
import { VERSION } from "./version";

export type BrokerOptions = {
  /** Injected in tests; production uses the platform `fetch`. */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
};

const DEFAULT_OWNER = "default";
const OWNER = /^[A-Za-z0-9._-]{1,64}$/;

export function createBroker(options: BrokerOptions = {}) {
  return {
    fetch(request: Request, env: Env): Promise<Response> {
      return handleRequest(request, env, options);
    },
  };
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: BrokerOptions = {},
): Promise<Response> {
  try {
    return await route(request, env, options);
  } catch (error) {
    if (error instanceof BrokerError) {
      return jsonResponse(brokerError(error.status, error.code, error.message), error.status);
    }
    // Unknown errors can carry request data in their message; only a fixed line is logged.
    console.error("broker request failed");
    return jsonResponse(brokerError(500, "INTERNAL_ERROR", "internal broker error"), 500);
  }
}

async function route(request: Request, env: Env, options: BrokerOptions): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v1/health") {
    if (request.method !== "GET") throw methodNotAllowed();
    return jsonResponse({ ok: true, version: VERSION });
  }

  await authenticate(request, env);
  const vault = vaultFor(env);
  const now = options.now ?? Date.now;

  if (path === "/v1/secrets" || path.startsWith("/v1/secrets/")) {
    const name = path.slice("/v1/secrets/".length);
    if (path === "/v1/secrets" || name === "" || name.includes("/")) throw notFound();
    if (request.method !== "GET") throw methodNotAllowed();
    return readSecret(secretName(decodePath(name)), env);
  }

  if (path === "/v1/connections") {
    if (request.method !== "GET") throw methodNotAllowed();
    const connections = await vault.list();
    return jsonResponse({ connections });
  }

  const segments = path.split("/").filter((segment) => segment !== "");
  // segments: ["v1", "connections", slug, ...]
  if (segments.length >= 3 && segments[0] === "v1" && segments[1] === "connections") {
    const slug = connectionSlug(decodePath(segments[2]));
    if (segments.length === 3) {
      if (request.method === "PUT") return putConnection(request, env, vault, slug, now);
      if (request.method === "DELETE") {
        await vault.remove(slug);
        return emptyResponse(204);
      }
      throw methodNotAllowed();
    }
    if (segments.length === 4 && segments[3] === "token") {
      if (request.method !== "POST") throw methodNotAllowed();
      return issueToken(env, vault, slug, options, now);
    }
  }

  throw notFound();
}

function readSecret(name: string, env: Env): Response {
  const value = secretValue(env, name);
  if (value === undefined) {
    throw new BrokerError(500, "SECRET_NOT_CONFIGURED", "secret is not configured on the broker");
  }
  return jsonResponse({ name, value });
}

async function putConnection(
  request: Request,
  env: Env,
  vault: VaultRpc,
  slug: string,
  now: () => number,
): Promise<Response> {
  const input = connectionInput(await readJsonObject(request));
  const key = masterKey(env);
  const aad = aadFor(slug);
  const tokens: StoredTokens = input.tokens;
  const ciphertext = await encryptCredential(key, JSON.stringify(tokens), aad);
  const record: VaultRecord = {
    slug,
    provider: input.provider,
    accountLabel: input.accountLabel,
    scopes: input.scopes,
    ciphertext,
    expiresAt: tokens.expiresAt ?? null,
    updatedAt: new Date(now()).toISOString(),
  };
  await vault.put(record);
  return emptyResponse(204);
}

async function issueToken(
  env: Env,
  vault: VaultRpc,
  slug: string,
  options: BrokerOptions,
  now: () => number,
): Promise<Response> {
  const stored = await vault.get(slug);
  if (stored === null) {
    throw new BrokerError(404, "CONNECTOR_NOT_FOUND", "connector connection not found");
  }
  const key = masterKey(env);
  const plaintext = await decryptCredential(key, stored.ciphertext, aadFor(slug));
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new BrokerError(500, "CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  const tokens = storedTokens(parsed);

  // A connection without a refresh token (plain GitHub OAuth app) can only hand back the token it
  // stored; refreshing would require credentials that do not exist for it.
  if (tokens.refreshToken === null) {
    if (tokens.accessToken === undefined) {
      throw new BrokerError(503, "CONNECTOR_NOT_CONFIGURED", "connector has no stored access token; reconnect the provider");
    }
    return jsonResponse({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt ?? null });
  }

  if (!needsRefresh(tokens.accessToken, tokens.expiresAt, now())) {
    return jsonResponse({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt ?? null });
  }

  const credentials = clientCredentials(env, stored.provider);
  const refreshed = await refreshAccessToken(
    stored.provider,
    tokens.refreshToken,
    credentials,
    options.fetchImpl ?? fetch,
    now,
  );
  const next: StoredTokens = {
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
  };
  const ciphertext = await encryptCredential(key, JSON.stringify(next), aadFor(slug));
  const updated = await vault.updateTokens(slug, { ciphertext, expiresAt: refreshed.expiresAt, provider: stored.provider });
  if (!updated) {
    throw new BrokerError(404, "CONNECTOR_NOT_FOUND", "connector connection not found");
  }
  return jsonResponse({ accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
}

function clientCredentials(env: Env, provider: Provider): { clientId: string; clientSecret: string } {
  const prefix = provider === "gmail" ? "google" : "github";
  const clientId = secretValue(env, `${prefix}_client_id`);
  const clientSecret = secretValue(env, `${prefix}_client_secret`);
  if (clientId === undefined || clientSecret === undefined) {
    throw new BrokerError(503, "CONNECTOR_NOT_CONFIGURED", `OAuth client credentials for ${provider} are not configured`);
  }
  return { clientId, clientSecret };
}

function masterKey(env: Env): Uint8Array {
  const raw = secretValue(env, "credential_master_key");
  if (raw === undefined) {
    throw new BrokerError(503, "BROKER_NOT_CONFIGURED", "credential_master_key is not configured");
  }
  return parseMasterKey(raw);
}

function secretValue(env: Env, name: string): string | undefined {
  const value: unknown = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function vaultFor(env: Env): VaultRpc {
  const owner = env.BROKER_OWNER_ID === undefined || env.BROKER_OWNER_ID === "" ? DEFAULT_OWNER : env.BROKER_OWNER_ID;
  if (!OWNER.test(owner)) {
    throw new BrokerError(503, "BROKER_NOT_CONFIGURED", "BROKER_OWNER_ID is invalid");
  }
  return env.VAULT.get(env.VAULT.idFromName(owner)) as unknown as VaultRpc;
}

function decodePath(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BrokerError(400, "INVALID_PATH", "path segment is not valid URL encoding");
  }
}

function notFound(): BrokerError {
  return new BrokerError(404, "NOT_FOUND", "no such broker route");
}

function methodNotAllowed(): BrokerError {
  return new BrokerError(405, "METHOD_NOT_ALLOWED", "method not allowed for this broker route");
}

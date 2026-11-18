import { BrokerError } from "./errors";

/**
 * Cloudflare Access already checked the service token before a request reaches this Worker. The
 * Worker verifies the signed `Cf-Access-Jwt-Assertion` itself as well, so a request that somehow
 * bypasses the Access policy is still rejected at the edge of the broker.
 */

export type AccessConfig = {
  readonly teamDomain: string;
  readonly audience: string;
};

type Jwk = {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
};

type JwksDocument = { readonly keys?: readonly Jwk[] };

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

type CacheEntry = {
  readonly keys: Map<string, CryptoKey>;
  expiresAt: number;
};

const jwksCache = new Map<string, CacheEntry>();

/** Test hook: forget cached signing keys so a fixture JWKS is picked up. */
export function clearAuthCache(): void {
  jwksCache.clear();
}

export function issuerFor(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function jwksUrlFor(teamDomain: string): string {
  return `${issuerFor(teamDomain)}/cdn-cgi/access/certs`;
}

export type VerifyOptions = {
  /** Milliseconds; injectable for expiry tests. */
  readonly now?: () => number;
  /** Injected in tests; defaults to the team's `cdn-cgi/access/certs`. */
  readonly fetchJwks?: (url: string) => Promise<JwksDocument>;
};

export type AccessClaims = Record<string, unknown>;

/**
 * Verifies signature, issuer, audience and lifetime. Any failure is the same 401 so callers learn
 * nothing about which check failed; the token itself is never quoted in the message.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  options: VerifyOptions = {},
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (header === null || claims === null) throw unauthorized();
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") throw unauthorized();

  const now = (options.now ?? Date.now)();
  const issuer = issuerFor(config.teamDomain);
  if (claims.iss !== issuer) throw unauthorized();
  if (!audienceMatches(claims.aud, config.audience)) throw unauthorized();
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw unauthorized();
  if (claims.exp * 1000 + CLOCK_SKEW_MS <= now) throw unauthorized();
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) throw unauthorized();
    if (claims.nbf * 1000 - CLOCK_SKEW_MS > now) throw unauthorized();
  }

  const key = await signingKey(config.teamDomain, header.kid, options.fetchJwks ?? fetchJwksDocument);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = fromBase64Url(parts[2]);
  if (signature === null) throw unauthorized();
  let valid = false;
  try {
    valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signed);
  } catch {
    valid = false;
  }
  if (!valid) throw unauthorized();
  return claims;
}

export type AccessEnv = {
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly BROKER_DEV_BYPASS?: string;
};

/** Dev bypass is accepted only from a loopback host and only when explicitly switched on. */
export function devBypassActive(env: AccessEnv, request: Request): boolean {
  if (env.BROKER_DEV_BYPASS !== "1") return false;
  if (!isLoopbackHost(new URL(request.url).hostname)) {
    throw new BrokerError(403, "DEV_BYPASS_FORBIDDEN", "BROKER_DEV_BYPASS is only valid on 127.0.0.1");
  }
  return true;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export async function authenticate(
  request: Request,
  env: AccessEnv,
  options: VerifyOptions = {},
): Promise<AccessClaims | null> {
  if (devBypassActive(env, request)) return null;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (teamDomain === undefined || teamDomain === "" || audience === undefined || audience === "") {
    throw new BrokerError(503, "BROKER_NOT_CONFIGURED", "ACCESS_TEAM_DOMAIN and ACCESS_AUD are required");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token === "") throw unauthorized();
  return verifyAccessJwt(token, { teamDomain, audience }, options);
}

async function signingKey(
  teamDomain: string,
  kid: string,
  fetchDocument: (url: string) => Promise<JwksDocument>,
): Promise<CryptoKey> {
  const url = jwksUrlFor(teamDomain);
  const cached = jwksCache.get(url);
  const fresh = cached !== undefined && cached.expiresAt > Date.now();
  const hit = fresh ? cached.keys.get(kid) : undefined;
  if (hit !== undefined) return hit;
  return loadSigningKey(url, kid, fetchDocument, cached);
}

async function loadSigningKey(
  url: string,
  kid: string,
  fetchDocument: (url: string) => Promise<JwksDocument>,
  stale: CacheEntry | undefined,
): Promise<CryptoKey> {
  let document: JwksDocument;
  try {
    document = await fetchDocument(url);
  } catch {
    // A transient JWKS failure must not be reported as a bad caller token.
    throw new BrokerError(503, "BROKER_AUTH_UNAVAILABLE", "access signing keys are unavailable");
  }
  const keys = new Map<string, CryptoKey>();
  for (const jwk of document.keys ?? []) {
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ));
    } catch {
      // Skip unusable keys; a healthy sibling may still verify the token.
    }
  }
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  const key = keys.get(kid);
  if (key !== undefined) return key;
  const fallback = stale?.keys.get(kid);
  if (fallback !== undefined) return fallback;
  throw unauthorized();
}

async function fetchJwksDocument(url: string): Promise<JwksDocument> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Drain nothing and quote nothing: the upstream body is not ours to log or return.
    throw new Error("jwks request failed");
  }
  return (await response.json()) as JwksDocument;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.some((entry) => entry === expected);
  return false;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = fromBase64Url(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fromBase64Url(value: string | undefined): Uint8Array | null {
  if (value === undefined || value === "" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function unauthorized(): BrokerError {
  return new BrokerError(401, "BROKER_UNAUTHORIZED", "access JWT is missing or invalid");
}

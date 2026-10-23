import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";
import { isAbsolute } from "node:path";
import { getCACertificates } from "node:tls";
import { ConfigurationError } from "./errors.js";

const KEY = /^[A-Z][A-Z0-9_]*$/;
const PLACEHOLDER = /^__vault_[A-Z][A-Z0-9_]*__$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const VAULT_PROXY_VARIABLES = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
] as const;

export function agentVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_VAULT_ENABLED;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new ConfigurationError("AGENT_VAULT_ENABLED must be 0 or 1");
}

/** This is an identifier, never a secret lookup. Only the broker resolves the key. */
export function vaultPlaceholder(key: string): string {
  if (!KEY.test(key)) throw new ConfigurationError("Agent Vault credential keys must use UPPER_SNAKE_CASE");
  return `__vault_${key}__`;
}

export function isVaultPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/**
 * OpenAI's SDK path treats a non-`sk-` value sent to api.openai.com as a ChatGPT sign-in token.
 * Accept the `sk-` prefix on a placeholder so a brokered OpenAI key keeps the API-key request shape.
 */
export function isBrokeredValue(value: string): boolean {
  return isVaultPlaceholder(value) || (value.startsWith("sk-") && isVaultPlaceholder(value.slice(3)));
}

/** Offline validation; does not contact the broker or print proxy credentials. */
export function readAgentVaultEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!agentVaultEnabled(env)) return undefined;
  const proxy = env.HTTPS_PROXY;
  let url: URL;
  try {
    url = new URL(proxy ?? "");
  } catch {
    throw new ConfigurationError("Agent Vault requires a valid HTTPS_PROXY");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigurationError("Agent Vault proxy must be an HTTP(S) origin without a path, query or fragment");
  }
  if (env.HTTP_PROXY !== proxy) throw new ConfigurationError("Agent Vault requires identical HTTP_PROXY and HTTPS_PROXY");
  for (const name of ["http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy"]) {
    // Windows process.env lookup ignores case; inspect actual keys instead.
    if (Object.keys(env).includes(name) && env[name]) throw new ConfigurationError(`Remove ${name}; Agent Vault uses uppercase HTTP_PROXY, HTTPS_PROXY and NO_PROXY`);
  }
  const noProxy = env.NO_PROXY ?? "";
  if (noProxy.split(",").some((host) => host.trim() !== "" && !LOOPBACK.has(host.trim()))) {
    throw new ConfigurationError("Agent Vault NO_PROXY may contain only exact loopback hosts");
  }
  if (env.NODE_USE_ENV_PROXY !== "1") throw new ConfigurationError("Agent Vault requires NODE_USE_ENV_PROXY=1 before starting Node");
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new ConfigurationError("Agent Vault requires TLS certificate verification");
  const ca = env.NODE_EXTRA_CA_CERTS;
  if (!ca || !isAbsolute(ca)) throw new ConfigurationError("Agent Vault requires an absolute NODE_EXTRA_CA_CERTS path");
  try {
    new X509Certificate(readFileSync(ca));
  } catch {
    throw new ConfigurationError("Agent Vault CA file must contain a readable PEM certificate");
  }
  for (const name of ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"]) {
    if (env[name] !== undefined && env[name] !== ca) {
      throw new ConfigurationError(`${name} must use the Agent Vault CA file`);
    }
  }
  return {
    HTTP_PROXY: proxy!, HTTPS_PROXY: proxy!, NO_PROXY: noProxy,
    NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca,
    SSL_CERT_FILE: ca, REQUESTS_CA_BUNDLE: ca, CURL_CA_BUNDLE: ca, GIT_SSL_CAINFO: ca,
  };
}

/** Run once at each network entry point, before SDKs make requests. */
export function initializeAgentVault(): void {
  const env = readAgentVaultEnvironment();
  if (!env) return;
  const certificate = new X509Certificate(readFileSync(env.NODE_EXTRA_CA_CERTS!));
  const loaded = getCACertificates("extra").some((pem) => new X509Certificate(pem).fingerprint256 === certificate.fingerprint256);
  if (!loaded) throw new ConfigurationError("Agent Vault CA was not loaded by Node; set NODE_EXTRA_CA_CERTS before process startup");
  Object.assign(process.env, env);
  setGlobalProxyFromEnv(env);
}

import { BrokerError } from "./errors";

/**
 * AES-256-GCM at rest, byte-compatible with `src/connectors/crypto.ts`:
 * `v1.<iv>.<tag>.<ciphertext>`, base64url without padding, 12-byte IV, 16-byte tag, and the
 * caller-supplied AAD. WebCrypto appends the tag to the ciphertext, so the storage format splits
 * it back out; a value encrypted by the host can be decrypted here and vice versa.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export async function encryptCredential(
  key: Uint8Array,
  plaintext: string,
  aad: string,
): Promise<string> {
  assertKey(key);
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad), tagLength: TAG_BYTES * 8 },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  ));
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return [VERSION, toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join(".");
}

export async function decryptCredential(
  key: Uint8Array,
  stored: string,
  aad: string,
): Promise<string> {
  assertKey(key);
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw unreadable();
  const iv = fromBase64Url(parts[1]);
  const tag = fromBase64Url(parts[2]);
  // An empty plaintext legitimately encrypts to an empty ciphertext segment.
  const ciphertext = fromBase64Url(parts[3], true);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw unreadable();
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.length);
  try {
    const cryptoKey = await importKey(key);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad), tagLength: TAG_BYTES * 8 },
      cryptoKey,
      sealed,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key, wrong AAD or tampering are indistinguishable on purpose.
    throw unreadable();
  }
}

/**
 * Accepts the same encodings as the host: 64 hex characters, base64/base64url for 32 bytes, or
 * exactly 32 UTF-8 bytes. The value itself never appears in the error.
 */
export function parseMasterKey(raw: string | undefined): Uint8Array {
  if (raw === undefined) throw invalidKey();
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return fromHex(text);
  if (/^[A-Za-z0-9+/_=-]{43,44}$/.test(text)) {
    try {
      const decoded = fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
      if (decoded.length === KEY_BYTES) return decoded;
    } catch {
      // Fall through to the raw-bytes rule.
    }
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === KEY_BYTES) return bytes;
  throw invalidKey();
}

export function aadFor(slug: string): string {
  return `connection:${slug}:oauth`;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw invalidKey();
}

function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function invalidKey(): BrokerError {
  return new BrokerError(500, "CONNECTOR_MASTER_KEY_INVALID", "credential_master_key must encode exactly 32 bytes");
}

function unreadable(): BrokerError {
  return new BrokerError(500, "CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential cannot be decrypted");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string | undefined, allowEmpty = false): Uint8Array {
  if (value === undefined) throw unreadable();
  if (value === "") {
    if (allowEmpty) return new Uint8Array(0);
    throw unreadable();
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unreadable();
  try {
    return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    // Non-canonical base64 (for example a length of 1 mod 4) is unreadable, not a crash.
    throw unreadable();
  }
}

function fromBase64(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

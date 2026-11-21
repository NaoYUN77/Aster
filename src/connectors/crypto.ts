import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConnectorError } from "./errors.js";

/**
 * Credential encryption at rest: AES-256-GCM with a random 96-bit IV per value. The additional
 * authenticated data binds a ciphertext to its connection, so copying a blob to another row fails
 * authentication instead of decrypting.
 *
 * Stored format: `v1.<iv>.<tag>.<ciphertext>` with base64url segments.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptCredential(key: Buffer, plaintext: string, aad: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(key: Buffer, stored: string, aad: string): string {
  assertKey(key);
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  const iv = decode(parts[1]);
  const tag = decode(parts[2]);
  const ciphertext = decode(parts[3]);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong AAD or tampering all look the same from here, and none may reveal details.
    throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential cannot be decrypted");
  }
}

function decode(value: string | undefined): Buffer {
  if (value === undefined || value === "") {
    throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new ConnectorError("CONNECTOR_MASTER_KEY_INVALID", "credential_master_key must encode exactly 32 bytes");
  }
}

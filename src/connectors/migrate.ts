import { decryptCredential } from "./crypto.js";
import { ConnectorError, safeConnectorMessage } from "./errors.js";
import { credentialAad, type OAuthToken } from "./providers.js";
import type { SecretProvider } from "./secrets.js";
import type { ConnectorStore } from "./store.js";
import type { TokenVault } from "./vault.js";

export type MigrationResult = {
  readonly migrated: number;
  readonly total: number;
};

/**
 * One-shot, opt-in move of locally encrypted tokens into the broker. Each row is copied first and
 * only then cleared locally, so a failure leaves the original ciphertext in place. Logging (if any)
 * belongs to the caller: this function returns counts and never includes token material or labels
 * in its errors — only the number of rows already moved.
 */
export async function migrateLocalCredentials(options: {
  readonly store: ConnectorStore;
  readonly vault: TokenVault;
  readonly secrets: SecretProvider;
}): Promise<MigrationResult> {
  const rows = options.store.credentialRows();
  if (rows.length === 0) return { migrated: 0, total: 0 };

  // Read the key once: a missing/invalid master key aborts before any row is touched.
  const masterKey = await options.secrets.masterKey();
  let migrated = 0;
  for (const row of rows) {
    try {
      let token: OAuthToken;
      try {
        token = JSON.parse(decryptCredential(masterKey, row.ciphertext, credentialAad(row.connection.id))) as OAuthToken;
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential cannot be decrypted");
      }
      if (typeof token.access_token !== "string" || token.access_token === "") {
        throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
      }
      if (token.refresh_token === undefined || token.refresh_token === "") {
        // The broker needs a refresh token to keep the connection alive without the browser flow.
        throw new ConnectorError("CONNECTOR_AUTH_EXPIRED", "local connector credential has no refresh token; reconnect it");
      }
      await options.vault.save(row.connection, token, {
        accountLabel: row.connection.accountLabel ?? row.connection.provider,
        scopes: row.connection.scopes,
      });
      options.store.clearCredential(row.connection.id);
      migrated += 1;
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : "CONNECTOR_CREDENTIAL_UNREADABLE";
      throw new ConnectorError(
        code,
        `${safeConnectorMessage(code)} (connector credential migration stopped after ${migrated} of ${rows.length})`,
      );
    }
  }
  return { migrated, total: rows.length };
}

import { randomBytes } from "node:crypto";
import { ConnectorError } from "./errors.js";

export type CredentialBinding = {
  readonly connectionId: string;
  readonly tool: string;
  readonly requestId: string;
  readonly ownerId: string;
};

type Lease = CredentialBinding & {
  readonly capability: string;
  readonly token: string;
  readonly expiresAt: number;
};

/**
 * In-memory capability broker. A tool never receives a decrypted token from the vault directly:
 * the service issues a one-use capability bound to connection, tool, request and owner, then
 * consumes it immediately to obtain the token for the upstream request. The token lives only in
 * process memory for the duration of the call; the capability is never exposed to the model, the
 * transcript, the trace or a log.
 */
export class CredentialBroker {
  readonly #leases = new Map<string, Lease>();

  issue(binding: CredentialBinding, token: string, ttlMs: number): string {
    const capability = randomBytes(32).toString("base64url");
    this.#leases.set(capability, {
      ...binding,
      capability,
      token,
      expiresAt: Date.now() + Math.max(1_000, ttlMs),
    });
    return capability;
  }

  consume(capability: string, binding: CredentialBinding): string {
    const lease = this.#leases.get(capability);
    // A failed binding check does not destroy the lease for its rightful caller only if the id is
    // wrong; a leaked capability must not be usable from another tool or owner.
    if (lease === undefined || lease.expiresAt <= Date.now()
      || lease.connectionId !== binding.connectionId
      || lease.tool !== binding.tool
      || lease.requestId !== binding.requestId
      || lease.ownerId !== binding.ownerId) {
      throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "credential lease is invalid or expired");
    }
    this.#leases.delete(capability);
    return lease.token;
  }

  revokeAll(): void {
    this.#leases.clear();
  }

  get size(): number {
    for (const [key, lease] of this.#leases) {
      if (lease.expiresAt <= Date.now()) this.#leases.delete(key);
    }
    return this.#leases.size;
  }
}

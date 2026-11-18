import { ConnectorError } from "./errors.js";
import { clip, connectorJson, connectorText } from "./http.js";

const API = "https://www.googleapis.com/drive/v3";
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const GOOGLE_DOC = "application/vnd.google-apps.document";
const MAX_CONTENT_CHARS = 20_000;
const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

export type GoogleDriveClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type DriveFileSummary = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly size: string | null;
  readonly webViewLink: string;
};

export type DriveFile = DriveFileSummary & {
  readonly description: string;
  /** Plain text of a Google Doc, or an empty string for any other file type. */
  readonly content: string;
  readonly truncated: boolean;
  /** Explains why content is absent and what the caller can do instead. */
  readonly note: string;
};

/** Read-only Google Drive client. It never downloads or returns binary content. */
export class GoogleDriveClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GoogleDriveClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async searchFiles(
    token: string,
    query: string,
    options: { readonly maxResults?: number } = {},
  ): Promise<DriveFileSummary[]> {
    const q = query.trim();
    if (q.length > 256) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must be at most 256 characters");
    const pageSize = Math.min(50, Math.max(1, Math.trunc(options.maxResults ?? 20)));
    // Drive search grammar: quote the term and escape quotes/backslashes so it cannot widen the query.
    const literal = q.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const params = new URLSearchParams({
      q: `(name contains '${literal}' or fullText contains '${literal}') and trashed = false`,
      pageSize: String(pageSize),
      orderBy: "modifiedTime desc",
      fields: `files(${FIELDS})`,
    });
    const body = await this.#get(token, `/files?${params.toString()}`, false);
    if (!isRecord(body) || !Array.isArray(body.files)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Drive response was invalid");
    }
    return body.files.slice(0, pageSize).flatMap((entry) => {
      const file = summaryFrom(entry);
      return file === undefined ? [] : [file];
    });
  }

  async getFile(token: string, fileId: string): Promise<DriveFile> {
    if (!FILE_ID.test(fileId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "file id is invalid");
    const params = new URLSearchParams({ fields: `${FIELDS},description` });
    const body = await this.#get(token, `/files/${encodeURIComponent(fileId)}?${params.toString()}`, true);
    const summary = summaryFrom(body);
    if (summary === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Drive response was invalid");
    const description = isRecord(body) && typeof body.description === "string" ? body.description : "";

    if (summary.mimeType === GOOGLE_DOC) {
      const text = await connectorText(
        `${API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
        { headers: { authorization: `Bearer ${token}`, accept: "text/plain" } },
        { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound: true },
      );
      const clipped = clip(text, MAX_CONTENT_CHARS);
      return {
        ...summary,
        description,
        content: clipped,
        truncated: clipped.length < [...text].length,
        note: "Exported from Google Docs as plain text.",
      };
    }

    const note = summary.mimeType.startsWith("application/vnd.google-apps.")
      ? "Google Workspace file type without a plain-text export here; open webViewLink instead."
      : "Binary or non-document file; only metadata is returned. Open webViewLink to download it.";
    return { ...summary, description, content: "", truncated: false, note };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function summaryFrom(value: unknown): DriveFileSummary | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  return {
    id: value.id,
    name: typeof value.name === "string" ? clip(value.name, 300) : "",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
    modifiedTime: typeof value.modifiedTime === "string" ? value.modifiedTime : "",
    size: typeof value.size === "string" ? value.size : null,
    webViewLink: typeof value.webViewLink === "string" ? value.webViewLink : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";

import { ConnectorError } from "./errors.js";
import { clip, connectorJson, connectorText, connectorWrite } from "./http.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const GOOGLE_DOC = "application/vnd.google-apps.document";
const TEXT_MIME = "text/plain";
const MAX_CONTENT_CHARS = 20_000;
const MAX_NAME_CHARS = 256;
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

/** Google Drive client for metadata, Docs export and plain-text files. It never downloads or uploads binary content. */
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

  /** Creates a plain-text file owned by the connected account. No binary upload exists here. */
  async createFile(
    token: string,
    input: { readonly name: string; readonly content: string },
  ): Promise<DriveFileSummary> {
    const name = boundedName(input.name);
    const content = boundedContent(input.content);
    const { body, contentType } = multipartBody({ name, mimeType: TEXT_MIME }, content);
    const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS });
    const result = await connectorWrite(`${UPLOAD_API}/files?${params.toString()}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": contentType },
      body,
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
    return fileIdentity(result);
  }

  /**
   * Renames and/or replaces the text content of a file. Only files Aster can write (created or
   * opened through the drive.file scope) succeed; Google Docs are not editable here.
   */
  async updateFile(
    token: string,
    fileId: string,
    input: { readonly name?: string; readonly content?: string },
  ): Promise<DriveFileSummary> {
    if (!FILE_ID.test(fileId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "file id is invalid");
    if (input.name === undefined && input.content === undefined) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "name or content is required");
    }
    const name = input.name === undefined ? undefined : boundedName(input.name);
    const params = new URLSearchParams({ fields: FIELDS });
    let result: unknown;
    if (input.content !== undefined) {
      const content = boundedContent(input.content);
      const metadata = { ...(name === undefined ? {} : { name }), mimeType: TEXT_MIME };
      const { body, contentType } = multipartBody(metadata, content);
      params.set("uploadType", "multipart");
      result = await connectorWrite(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": contentType },
        body,
      }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
    } else {
      result = await connectorWrite(`${API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
    }
    return fileIdentity(result);
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function boundedName(value: string): string {
  const name = value.trim();
  if (name === "" || name.length > MAX_NAME_CHARS || /[\\/\u0000-\u001f]/.test(name)) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "name must be 1-256 characters without slashes or control characters");
  }
  return name;
}

function boundedContent(value: string): string {
  if (value.length > MAX_CONTENT_CHARS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `content must be at most ${MAX_CONTENT_CHARS} characters`);
  }
  return value;
}

/** multipart/related: a JSON metadata part followed by the UTF-8 text part. */
function multipartBody(metadata: Record<string, unknown>, content: string): { body: string; contentType: string } {
  let boundary = `aster-${randomUUID().replace(/-/g, "")}`;
  for (let attempt = 0; attempt < 5 && content.includes(boundary); attempt += 1) {
    boundary = `aster-${randomUUID().replace(/-/g, "")}`;
  }
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

function fileIdentity(value: unknown): DriveFileSummary {
  const summary = summaryFrom(value);
  if (summary === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Drive response was invalid");
  return summary;
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

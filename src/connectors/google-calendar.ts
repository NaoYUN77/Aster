import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://www.googleapis.com/calendar/v3";
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const MAX_DESCRIPTION_CHARS = 20_000;

export type GoogleCalendarClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly now?: () => Date;
};

export type CalendarEventSummary = {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location: string;
  readonly status: string;
  readonly htmlLink: string;
};

export type CalendarEvent = CalendarEventSummary & {
  readonly description: string;
  readonly truncated: boolean;
  readonly attendees: readonly string[];
};

/** Read-only Google Calendar client. It only reads the primary calendar. */
export class GoogleCalendarClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: GoogleCalendarClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  async listEvents(
    token: string,
    options: { readonly days?: number; readonly maxResults?: number } = {},
  ): Promise<CalendarEventSummary[]> {
    const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(options.days ?? DEFAULT_DAYS)));
    const maxResults = Math.min(50, Math.max(1, Math.trunc(options.maxResults ?? 20)));
    const timeMin = this.#now();
    const timeMax = new Date(timeMin.getTime() + days * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(maxResults),
      fields: "items(id,summary,start,end,location,status,htmlLink)",
    });
    const body = await this.#get(token, `/calendars/primary/events?${params.toString()}`, false);
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Calendar response was invalid");
    }
    return body.items.slice(0, maxResults).flatMap((entry) => {
      const summary = summaryFrom(entry);
      return summary === undefined ? [] : [summary];
    });
  }

  async getEvent(token: string, eventId: string): Promise<CalendarEvent> {
    if (!EVENT_ID.test(eventId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "event id is invalid");
    const body = await this.#get(token, `/calendars/primary/events/${encodeURIComponent(eventId)}`, true);
    const summary = summaryFrom(body);
    if (summary === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Calendar response was invalid");
    const description = isRecord(body) && typeof body.description === "string" ? body.description : "";
    const clipped = clip(description, MAX_DESCRIPTION_CHARS);
    const attendees = isRecord(body) && Array.isArray(body.attendees)
      ? body.attendees.slice(0, 100).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const email = typeof entry.email === "string" ? entry.email : "";
        const name = typeof entry.displayName === "string" ? entry.displayName : "";
        return email === "" ? [] : [name === "" ? email : `${name} <${email}>`];
      })
      : [];
    return {
      ...summary,
      description: clipped,
      truncated: clipped.length < [...description].length,
      attendees,
    };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function summaryFrom(value: unknown): CalendarEventSummary | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  return {
    id: value.id,
    summary: typeof value.summary === "string" ? clip(value.summary, 300) : "(no title)",
    start: dateTimeOf(value.start),
    end: dateTimeOf(value.end),
    location: typeof value.location === "string" ? clip(value.location, 300) : "",
    status: typeof value.status === "string" ? value.status : "",
    htmlLink: typeof value.htmlLink === "string" ? value.htmlLink : "",
  };
}

/** All-day events carry `date`; timed events carry `dateTime`; both are ISO 8601 strings. */
function dateTimeOf(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.dateTime === "string") return value.dateTime;
  return typeof value.date === "string" ? value.date : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

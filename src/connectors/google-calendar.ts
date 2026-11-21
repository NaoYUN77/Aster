import { ConnectorError } from "./errors.js";
import { clip, connectorJson, connectorWrite } from "./http.js";

const API = "https://www.googleapis.com/calendar/v3";
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_SUMMARY = 256;
const MAX_LOCATION = 500;
/** RFC 3339 with an explicit UTC offset, or the same shape without one (then time_zone is required). */
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PLAIN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
const EVENT_FIELDS = "id,summary,start,end,htmlLink";

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

/** Google Calendar client for the primary calendar: list, read, create and update. No delete exists here. */
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

  /**
   * Creates an event on the primary calendar. Times must be explicit: either an RFC 3339 stamp
   * with an offset, or a local stamp plus `timeZone`. No attendees are invited.
   */
  async createEvent(
    token: string,
    input: {
      readonly summary: string;
      readonly start: string;
      readonly end: string;
      readonly timeZone?: string;
      readonly description?: string;
      readonly location?: string;
    },
  ): Promise<{ readonly id: string; readonly summary: string; readonly start: string; readonly end: string; readonly htmlLink: string }> {
    const summary = boundedSummary(input.summary);
    const start = eventTime(input.start, "start", input.timeZone);
    const end = eventTime(input.end, "end", input.timeZone);
    assertOrder(start.dateTime, end.dateTime);
    const description = boundedDescription(input.description ?? "");
    const location = boundedLocation(input.location ?? "");
    const payload = {
      summary,
      start,
      end,
      ...(description === "" ? {} : { description }),
      ...(location === "" ? {} : { location }),
    };
    const params = new URLSearchParams({ fields: EVENT_FIELDS });
    const body = await this.#write(token, "POST", `/calendars/primary/events?${params.toString()}`, payload);
    return eventIdentity(body);
  }

  /** Patches summary, description, location and/or times. At least one field is required. */
  async updateEvent(
    token: string,
    eventId: string,
    input: {
      readonly summary?: string;
      readonly description?: string;
      readonly location?: string;
      readonly start?: string;
      readonly end?: string;
      readonly timeZone?: string;
    },
  ): Promise<{ readonly id: string; readonly summary: string; readonly start: string; readonly end: string; readonly htmlLink: string }> {
    if (!EVENT_ID.test(eventId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "event id is invalid");
    if (input.start === undefined && input.end === undefined && input.summary === undefined
      && input.description === undefined && input.location === undefined) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "summary, description, location, start or end is required");
    }
    if ((input.start === undefined) !== (input.end === undefined)) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "start and end must be given together");
    }
    const payload: Record<string, unknown> = {};
    if (input.summary !== undefined) payload.summary = boundedSummary(input.summary);
    if (input.description !== undefined) payload.description = boundedDescription(input.description);
    if (input.location !== undefined) payload.location = boundedLocation(input.location);
    if (input.start !== undefined && input.end !== undefined) {
      const start = eventTime(input.start, "start", input.timeZone);
      const end = eventTime(input.end, "end", input.timeZone);
      assertOrder(start.dateTime, end.dateTime);
      payload.start = start;
      payload.end = end;
    }
    const params = new URLSearchParams({ fields: EVENT_FIELDS });
    const body = await this.#write(
      token,
      "PATCH",
      `/calendars/primary/events/${encodeURIComponent(eventId)}?${params.toString()}`,
      payload,
    );
    return eventIdentity(body);
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }

  async #write(token: string, method: "POST" | "PATCH", path: string, payload: unknown): Promise<unknown> {
    return connectorWrite(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
  }
}

function boundedSummary(value: string): string {
  const summary = value.trim();
  if (summary === "" || summary.length > MAX_SUMMARY) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "summary must be 1-256 characters");
  }
  return summary;
}

function boundedDescription(value: string): string {
  if (value.length > MAX_DESCRIPTION_CHARS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return value;
}

function boundedLocation(value: string): string {
  const location = value.trim();
  if (location.length > MAX_LOCATION) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `location must be at most ${MAX_LOCATION} characters`);
  }
  return location;
}

/** Rejects ambiguous times: an offset is required unless the caller names the time zone. */
function eventTime(value: string, field: "start" | "end", timeZone: string | undefined): { dateTime: string; timeZone?: string } {
  const stamp = value.trim();
  if (OFFSET_TIME.test(stamp) && Number.isFinite(Date.parse(stamp))) {
    return timeZone === undefined ? { dateTime: stamp } : { dateTime: stamp, timeZone: validZone(timeZone) };
  }
  if (PLAIN_TIME.test(stamp)) {
    if (timeZone === undefined) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", `${field} has no UTC offset; supply time_zone (e.g. Asia/Shanghai)`);
    }
    return { dateTime: stamp, timeZone: validZone(timeZone) };
  }
  throw new ConnectorError("CONNECTOR_INVALID_INPUT", `${field} must be an RFC 3339 timestamp such as 2026-11-20T10:00:00+08:00`);
}

function validZone(value: string): string {
  const zone = value.trim();
  if (!TIME_ZONE.test(zone)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "time_zone is invalid");
  return zone;
}

function assertOrder(start: string, end: string): void {
  const startAt = Date.parse(start);
  const endAt = Date.parse(end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "end must be after start");
  }
}

function eventIdentity(value: unknown): { id: string; summary: string; start: string; end: string; htmlLink: string } {
  const identity = summaryFrom(value);
  if (!isRecord(value) || identity === undefined) {
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google Calendar response was invalid");
  }
  return {
    id: identity.id,
    summary: identity.summary,
    start: identity.start,
    end: identity.end,
    htmlLink: typeof value.htmlLink === "string" ? value.htmlLink : "",
  };
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

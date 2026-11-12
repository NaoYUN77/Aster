/**
 * Composition of the one line a watcher delivers. Every adapter hands over structured facts and this
 * module turns them into deterministic text; nothing here parses prose, and nothing here chooses who
 * receives the line. Titles and URLs arrive from the open internet, so they are flattened to a single
 * bounded line and a link is kept only when it is a plain public HTTP(S) URL — a feed can never smuggle
 * formatting, newlines or a `mailto:`/`javascript:` target into the message.
 */

export const WATCH_SUMMARY_MAX_CHARS = 240;
export const WATCH_LINE_MAX_CHARS = 500;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;

/** Flattens untrusted text: no control characters, no newlines, bounded by code points. */
export function cleanText(value: string, maxChars = WATCH_SUMMARY_MAX_CHARS): string {
  const flat = value.replace(CONTROL, " ").replace(WHITESPACE, " ").trim();
  const points = [...flat];
  return points.length <= maxChars ? flat : `${points.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/**
 * The link half of a line. A non-HTTP target is dropped rather than shown: a feed entry is data, and
 * data is not allowed to decide what the bot points at.
 */
export function safeLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (raw === "" || raw.length > 2_000) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.toString();
}

/** `[跟踪 #7] <one sentence> <link>` — the exact shape the delivery side and the model may rewrite. */
export function watchLine(watcherId: number, summary: string, link?: string): string {
  const body = cleanText(summary, WATCH_SUMMARY_MAX_CHARS);
  const tail = safeLink(link);
  const line = `[跟踪 #${Math.trunc(watcherId)}] ${body}${tail === undefined ? "" : ` ${tail}`}`;
  return line.slice(0, WATCH_LINE_MAX_CHARS);
}

export type FeedFacts = {
  readonly feed?: string;
  readonly title?: string;
  readonly link?: string;
};

/** A new feed entry. The feed's own name leads so two watches on one site stay distinguishable. */
export function feedText(watcherId: number, facts: FeedFacts): string {
  const feed = facts.feed === undefined ? "" : cleanText(facts.feed, 80);
  const title = cleanText(facts.title ?? "新条目");
  return watchLine(watcherId, feed === "" ? `新内容：${title}` : `${feed} 有新内容：${title}`, facts.link);
}

export type GithubRunFacts = {
  readonly repo: string;
  readonly runId: string | number;
  readonly name?: string;
  readonly conclusion: string;
  readonly url?: string;
};

/** A finished workflow run; only terminal conclusions are ever composed into this line. */
export function githubRunText(watcherId: number, facts: GithubRunFacts): string {
  const repo = cleanText(facts.repo, 120);
  const name = cleanText(facts.name ?? "工作流", 80);
  const conclusion = cleanText(facts.conclusion, 40);
  return watchLine(watcherId, `${repo} 的 ${name} 运行 #${String(facts.runId).slice(0, 40)} 已结束：${conclusion}`, facts.url);
}

export type GithubPullRequestFacts = {
  readonly repo: string;
  readonly number: string | number;
  readonly title?: string;
  /** `merged` or `closed`; an intermediate state must never reach this function. */
  readonly outcome: string;
  readonly url?: string;
};

export function githubPullRequestText(watcherId: number, facts: GithubPullRequestFacts): string {
  const repo = cleanText(facts.repo, 120);
  const title = cleanText(facts.title ?? "", 120);
  const outcome = facts.outcome === "merged" ? "已合并" : "已关闭";
  const named = title === "" ? "" : `（${title}）`;
  return watchLine(watcherId, `${repo} 的 PR #${String(facts.number).slice(0, 20)}${named} ${outcome}`, facts.url);
}

export type GithubIssueFacts = {
  readonly repo: string;
  readonly number: string | number;
  readonly title?: string;
  readonly state: string;
  readonly url?: string;
};

export function githubIssueText(watcherId: number, facts: GithubIssueFacts): string {
  const repo = cleanText(facts.repo, 120);
  const title = cleanText(facts.title ?? "", 120);
  const state = cleanText(facts.state, 20);
  const named = title === "" ? "" : `（${title}）`;
  return watchLine(watcherId, `${repo} 的 issue #${String(facts.number).slice(0, 20)}${named} 变为 ${state}`, facts.url);
}

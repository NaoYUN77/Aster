import type { WatchKind } from "./protocol.js";

/**
 * Deterministic message text.
 *
 * Everything that reaches this module came from outside — a feed title, a repository name, a
 * webhook conclusion — so it is treated as data: control characters and line breaks are removed,
 * length is bounded, and links are reduced to a plain public HTTP(S) URL. The result is one line the
 * host can deliver as-is; a model may later rewrite it, but never the other way round.
 */

const MAX_SENTENCE_CHARS = 280;
const MAX_TITLE_CHARS = 200;
const MAX_LINK_CHARS = 2_048;

/** Keep one line: strip controls, collapse runs of whitespace, and bound the code-point length. */
export function oneLine(value: string, maxChars = MAX_SENTENCE_CHARS): string {
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...cleaned];
  return points.length <= maxChars ? cleaned : `${points.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/** A link is only useful if it is an absolute public HTTP(S) URL; anything else is dropped. */
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_LINK_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
  url.hash = "";
  return url.toString();
}

function fact(facts: Readonly<Record<string, string | number | boolean>>, key: string): string {
  const value = facts[key];
  return value === undefined || value === null ? "" : oneLine(String(value), 120);
}

function identifier(facts: Readonly<Record<string, string | number | boolean>>, key: string): string {
  return fact(facts, key).replace(/[\s#]/g, "");
}

function conclusionLabel(conclusion: string): string {
  switch (conclusion) {
    case "success": return "成功";
    case "failure": return "失败";
    case "cancelled": return "已取消";
    case "timed_out": return "超时";
    case "action_required": return "需要处理";
    case "neutral": return "完成";
    case "skipped": return "已跳过";
    case "stale": return "已过期";
    default: return conclusion === "" ? "结束" : oneLine(conclusion, 40);
  }
}

function withLink(sentence: string, facts: Readonly<Record<string, string | number | boolean>>): string {
  const link = safeLink(facts.url ?? facts.link);
  return link === undefined ? sentence : `${sentence} ${link}`;
}

export function runText(facts: Readonly<Record<string, string | number | boolean>>): string {
  const repo = identifier(facts, "repo") || "仓库";
  const runId = identifier(facts, "run_id") || "?";
  return withLink(`CI ${repo} 运行 #${runId} ${conclusionLabel(fact(facts, "conclusion"))}`, facts);
}

export function checksText(facts: Readonly<Record<string, string | number | boolean>>): string {
  const repo = identifier(facts, "repo") || "仓库";
  return withLink(`CI ${repo} 检查套件 ${conclusionLabel(fact(facts, "conclusion"))}`, facts);
}

export function pullRequestText(facts: Readonly<Record<string, string | number | boolean>>): string {
  const repo = identifier(facts, "repo") || "仓库";
  const number = identifier(facts, "number") || "?";
  const state = fact(facts, "state");
  const sentence = state === "merged" ? `PR ${repo}#${number} 已合并` : `PR ${repo}#${number} 已关闭（未合并）`;
  return withLink(sentence, facts);
}

export function issueText(facts: Readonly<Record<string, string | number | boolean>>): string {
  const repo = identifier(facts, "repo") || "仓库";
  const number = identifier(facts, "number") || "?";
  return withLink(`${repo} issue #${number} 已关闭`, facts);
}

/** A feed item's title is the whole sentence; the link follows it when it is usable. */
export function feedText(facts: Readonly<Record<string, string | number | boolean>>): string {
  const title = oneLine(fact(facts, "title") || "新内容", MAX_TITLE_CHARS);
  return withLink(title, facts);
}

export function xText(facts: Readonly<Record<string, string | number | boolean>>): string {
  return feedText(facts);
}

/** The one entry point adapters use, so every kind has a single deterministic line. */
export function eventText(kind: WatchKind, facts: Readonly<Record<string, string | number | boolean>>): string {
  switch (kind) {
    case "github_run": return runText(facts);
    case "github_pr": return pullRequestText(facts);
    case "github_events": return issueText(facts);
    case "feed": return feedText(facts);
    case "x": return xText(facts);
  }
}

/** Facts are bounded JSON scalars; the store serializes them and never interprets them. */
export function boundedFacts(
  facts: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    result[key.slice(0, 64)] = typeof value === "string" ? value.slice(0, 2_000) : value;
  }
  return result;
}

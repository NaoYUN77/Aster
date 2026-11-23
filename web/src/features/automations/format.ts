import type {
  RoutineSchedule,
  RunStatus,
  SourceStatus,
  WatchKind,
} from "@/api/automations";

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export function formatSchedule(spec: RoutineSchedule): string {
  switch (spec.kind) {
    case "daily":
      return `每天 ${spec.at}`;
    case "weekly": {
      const days = spec.days
        .map((d) => WEEKDAY_LABELS[d] ?? `周${d}`)
        .join("、");
      return `每${days || "周"} ${spec.at}`;
    }
    case "every": {
      const base =
        spec.minutes >= 60 && spec.minutes % 60 === 0
          ? `每 ${spec.minutes / 60} 小时`
          : `每 ${spec.minutes} 分钟`;
      if (spec.from && spec.to) return `${base}（${spec.from}–${spec.to}）`;
      return base;
    }
  }
}

export function formatIntervalSec(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds >= 60) return `每 ${Math.round(seconds / 60)} 分钟`;
  return `每 ${seconds} 秒`;
}

export function formatRelativeTime(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diffSec = Math.round((ts - nowMs) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 45) return diffSec >= 0 ? "即将" : "刚刚";
  const mins = Math.round(abs / 60);
  if (mins < 60) return diffSec >= 0 ? `${mins} 分钟后` : `${mins} 分钟前`;
  const hours = Math.round(abs / 3600);
  if (hours < 48) return diffSec >= 0 ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.round(abs / 86_400);
  return diffSec >= 0 ? `${days} 天后` : `${days} 天前`;
}

export function formatShortDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ts));
  }
}

export function watchKindLabel(kind: WatchKind): string {
  switch (kind) {
    case "feed":
      return "RSS";
    case "x":
      return "X";
    case "github_run":
      return "GitHub CI";
    case "github_pr":
      return "GitHub PR";
    case "github_events":
      return "GitHub 动态";
  }
}

export function sourceStatusMeta(status: SourceStatus): {
  label: string;
  variant: "success" | "warning" | "destructive" | "secondary";
} {
  switch (status) {
    case "active":
      return { label: "正常", variant: "success" };
    case "backoff":
      return { label: "退避重试", variant: "warning" };
    case "error":
      return { label: "异常", variant: "destructive" };
    case "paused":
      return { label: "已暂停", variant: "secondary" };
    case "stopped":
      return { label: "已停止", variant: "secondary" };
  }
}

export function runStatusMeta(status: RunStatus): {
  label: string;
  dotClass: string;
  textClass: string;
} {
  switch (status) {
    case "succeeded":
      return { label: "成功", dotClass: "bg-success", textClass: "text-success" };
    case "suppressed":
      return { label: "无事未报", dotClass: "bg-muted-foreground/60", textClass: "text-muted-foreground" };
    case "failed":
      return { label: "失败", dotClass: "bg-destructive", textClass: "text-destructive" };
    case "running":
      return { label: "运行中", dotClass: "bg-primary animate-pulse", textClass: "text-primary" };
    case "queued":
      return { label: "排队中", dotClass: "bg-warning", textClass: "text-warning" };
    case "skipped":
      return { label: "已跳过", dotClass: "bg-muted-foreground/50", textClass: "text-muted-foreground" };
  }
}

const ERROR_CODE_LABELS: Record<string, string> = {
  WATCH_RATE_LIMITED: "源站限流",
  WATCH_FETCH_TIMEOUT: "抓取超时",
  WATCH_SOURCE_AUTH: "源站认证失败",
  WATCH_SOURCE_GONE: "源地址已失效",
  WATCH_PARSE_FAILED: "内容解析失败",
  WATCH_FEED_TOO_LARGE: "订阅内容过大",
  UPSTREAM_TIMEOUT: "模型请求超时",
  PROCESS_INTERRUPTED: "进程重启中断",
  MISSED_WINDOW: "错过执行窗口",
};

export function formatErrorCode(code: string | null): string {
  if (!code) return "";
  return ERROR_CODE_LABELS[code] ? `${ERROR_CODE_LABELS[code]}（${code}）` : code;
}

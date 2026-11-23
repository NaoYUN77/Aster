import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock,
  Inbox,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  AutomationsResponse,
  ReminderItem,
  RoutineItem,
  WatchDigestItem,
  WatcherItem,
} from "@/api/automations";
import { userFacingMessage } from "@/api/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import {
  formatErrorCode,
  formatIntervalSec,
  formatRelativeTime,
  formatSchedule,
  formatShortDateTime,
  runStatusMeta,
  sourceStatusMeta,
  watchKindLabel,
} from "./format";
import {
  isRoutineUnhealthy,
  isWatcherUnhealthy,
  summarizeAutomations,
  useAutomationMutations,
  useAutomationsQuery,
} from "./use-automations";

type TabId = "routines" | "watchers" | "reminders";

type InlineConfirmProps = {
  idleLabel: string;
  confirmLabel: string;
  icon: React.ReactNode;
  busy?: boolean;
  onConfirm: () => void;
};

function InlineConfirmAction({
  idleLabel,
  confirmLabel,
  icon,
  busy = false,
  onConfirm,
}: InlineConfirmProps) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="inline-flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            onConfirm();
            setConfirming(false);
          }}
          className="h-7 rounded-full px-2.5 text-xs"
        >
          {busy ? <Spinner className="size-3" /> : confirmLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
          className="h-7 rounded-full px-2 text-xs text-muted-foreground"
        >
          取消
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={() => setConfirming(true)}
      className="h-7 gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      aria-label={idleLabel}
    >
      {icon}
      <span>{idleLabel}</span>
    </Button>
  );
}

function EmptyState({
  icon,
  title,
  description,
  examples,
  onBackToChat,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  examples: string[];
  onBackToChat: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/25 px-5 py-10 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-4 flex flex-col gap-1.5 text-left">
        {examples.map((example) => (
          <div
            key={example}
            className="rounded-lg bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-2xs ring-1 ring-border/60"
          >
            “{example}”
          </div>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={onBackToChat}
        className="mt-4 rounded-full px-4 text-xs"
      >
        回到对话创建
      </Button>
    </div>
  );
}

function RoutineCard({
  item,
  globalPaused,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  busyId,
}: {
  item: RoutineItem;
  globalPaused: boolean;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onRunNow: (id: number) => void;
  onDelete: (id: number) => void;
  busyId: number | null;
}) {
  const [runsOpen, setRunsOpen] = useState(false);
  const unhealthy = isRoutineUnhealthy(item);
  const isPaused = item.status === "paused";
  const isBusy = busyId === item.id;
  const lastRun = item.recentRuns[0];
  const bodySnippet = item.mode === "agent" ? item.brief : item.text;

  return (
    <article className="rounded-xl border border-border/80 bg-background/70 p-3.5 transition-colors hover:border-border">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold leading-snug text-foreground">{item.title}</h3>
            {unhealthy ? (
              <Badge variant="destructive" className="gap-1 text-[11px]">
                <AlertTriangle className="size-3" />
                异常
              </Badge>
            ) : isPaused ? (
              <Badge variant="secondary" className="text-[11px]">
                已暂停
              </Badge>
            ) : (
              <Badge variant="success" className="text-[11px]">
                运行中
              </Badge>
            )}
            <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
              {item.mode === "agent" ? "Agent" : "纯通知"}
            </Badge>
            {item.mode === "agent" && (
              <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
                {item.delivery === "report" ? "有事才报" : "每次必报"}
              </Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-foreground/85">
              <Clock className="size-3 text-muted-foreground" />
              {formatSchedule(item.schedule.spec)}
            </span>
            <span aria-hidden>·</span>
            <span>{item.timezone}</span>
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isBusy || isPaused || globalPaused}
            onClick={() => onRunNow(item.id)}
            title={
              globalPaused
                ? "定时任务服务已全局暂停"
                : isPaused
                  ? "请先恢复任务后再运行"
                  : "立即加入执行队列"
            }
            className="h-7 gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Play className="size-3" />
            <span>立即运行</span>
          </Button>
          {isPaused ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={isBusy}
              onClick={() => onResume(item.id)}
              className="h-7 gap-1 rounded-full px-2.5 text-xs"
            >
              <Play className="size-3" />
              <span>恢复</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => onPause(item.id)}
              className="h-7 gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pause className="size-3" />
              <span>暂停</span>
            </Button>
          )}
          <InlineConfirmAction
            idleLabel="删除"
            confirmLabel="确认删除"
            icon={<Trash2 className="size-3" />}
            busy={isBusy}
            onConfirm={() => onDelete(item.id)}
          />
        </div>
      </div>

      {bodySnippet && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {bodySnippet}
        </p>
      )}

      {unhealthy && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words leading-relaxed">
            连续失败 {item.consecutiveFailures} 次
            {item.lastError ? ` · ${formatErrorCode(item.lastError)}` : ""}
          </span>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            下次执行：
            <strong className="font-medium text-foreground/85">
              {isPaused
                ? "已暂停"
                : `${formatRelativeTime(item.schedule.nextDueAt)}（${formatShortDateTime(item.schedule.nextDueAt, item.timezone)}）`}
            </strong>
          </span>
          <span>
            上次执行：
            {lastRun ? (
              <span className={cn("font-medium", runStatusMeta(lastRun.status).textClass)}>
                {runStatusMeta(lastRun.status).label} ·{" "}
                {formatRelativeTime(lastRun.finishedAt ?? lastRun.createdAt)}
              </span>
            ) : (
              <span>尚未执行</span>
            )}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setRunsOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-expanded={runsOpen}
        >
          <span>执行记录（{item.recentRuns.length}）</span>
          {runsOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      </div>

      {runsOpen && (
        <div className="mt-2 space-y-1.5 rounded-lg bg-muted/40 p-2.5">
          {item.recentRuns.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground">暂无执行记录</p>
          ) : (
            item.recentRuns.map((run) => {
              const meta = runStatusMeta(run.status);
              return (
                <div
                  key={run.id}
                  className="flex flex-col gap-0.5 rounded-md bg-card/80 px-2.5 py-1.5 text-xs ring-1 ring-border/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
                      <span className={meta.textClass}>{meta.label}</span>
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {run.trigger === "manual" ? "手动触发" : "定时触发"}
                      </span>
                    </span>
                    <span className="tabular-nums text-[11px] text-muted-foreground">
                      {formatShortDateTime(run.finishedAt ?? run.startedAt ?? run.createdAt, item.timezone)}
                    </span>
                  </div>
                  {run.errorCode && (
                    <p className="text-[11px] text-destructive">
                      {formatErrorCode(run.errorCode)}
                    </p>
                  )}
                  {!run.errorCode && run.reply && run.status !== "suppressed" && (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{run.reply}</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </article>
  );
}

function WatchDigestBanner({
  items,
  flushing,
  onFlush,
}: {
  items: WatchDigestItem[];
  flushing: boolean;
  onFlush: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Inbox className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">
              待发简报 · {items.length} 条动态暂存
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              点击展开预览，或立即汇总推送到主对话
            </p>
          </div>
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>

        <Button
          type="button"
          size="sm"
          disabled={flushing}
          onClick={onFlush}
          className="h-7 shrink-0 gap-1.5 rounded-full px-3 text-xs"
        >
          {flushing ? <Spinner className="size-3" /> : <Send className="size-3" />}
          <span>立即汇总推送</span>
        </Button>
      </div>

      {expanded && (
        <ul className="mt-2.5 space-y-1.5 border-t border-primary/15 pt-2.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-lg bg-card/85 px-2.5 py-2 text-xs ring-1 ring-border/60"
            >
              <p className="leading-relaxed text-foreground">{item.text}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{item.triageReason ?? "已暂存待简报汇总"}</span>
                <span className="tabular-nums">{formatRelativeTime(item.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WatcherCard({
  item,
  timezone,
  onStop,
  busy,
}: {
  item: WatcherItem;
  timezone: string;
  onStop: (id: number) => void;
  busy: boolean;
}) {
  const health = sourceStatusMeta(item.source.status);
  const unhealthy = isWatcherUnhealthy(item);
  const nextAt = item.source.mode === "poll" ? item.source.nextCheckAt : item.source.reconcileAt;

  return (
    <article className="rounded-xl border border-border/80 bg-background/70 p-3.5 transition-colors hover:border-border">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold leading-snug text-foreground">{item.label}</h3>
            <Badge variant={health.variant} className="text-[11px]">
              {health.label}
            </Badge>
            <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
              {watchKindLabel(item.kind)}
            </Badge>
            <Badge
              variant="outline"
              className="gap-1 text-[11px] font-normal text-muted-foreground"
            >
              {item.deliveryMode === "triage" ? (
                <>
                  <Sparkles className="size-2.5 text-primary" />
                  AI 研判
                </>
              ) : (
                "直推"
              )}
            </Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={item.target}>
            {item.target}
          </p>
        </div>

        <div className="shrink-0">
          <InlineConfirmAction
            idleLabel="停止监控"
            confirmLabel="确认停止"
            icon={<Square className="size-3" />}
            busy={busy}
            onConfirm={() => onStop(item.id)}
          />
        </div>
      </div>

      {item.triagePrompt && (
        <p className="mt-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">筛选偏好：</span>
          {item.triagePrompt}
        </p>
      )}

      {unhealthy && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/15 px-2.5 py-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words leading-relaxed">
            连续异常 {item.source.failures} 次
            {item.source.lastError ? ` · ${formatErrorCode(item.source.lastError)}` : ""}
          </span>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span>
          检测方式：{item.source.mode === "push" ? "事件推送" : formatIntervalSec(item.source.intervalSec)}
        </span>
        <span>·</span>
        <span>
          上次检查：{formatRelativeTime(item.source.lastCheckAt)}
        </span>
        {nextAt && (
          <>
            <span>·</span>
            <span>
              下次检查：{formatRelativeTime(nextAt)}（{formatShortDateTime(nextAt, timezone)}）
            </span>
          </>
        )}
      </div>
    </article>
  );
}

function ReminderCard({
  item,
  onCancel,
  busy,
}: {
  item: ReminderItem;
  onCancel: (id: number) => void;
  busy: boolean;
}) {
  return (
    <article className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/80 bg-background/70 p-3.5 transition-colors hover:border-border">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-foreground">{item.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-[11px] font-medium">
            {formatRelativeTime(item.dueAt)}
          </Badge>
          <span className="tabular-nums">
            {formatShortDateTime(item.dueAt, item.timezone)}
          </span>
          <span>·</span>
          <span>{item.timezone}</span>
          {item.status !== "pending" && (
            <Badge variant="warning" className="text-[11px]">
              {item.status === "sending" ? "发送中" : "即将推送"}
            </Badge>
          )}
        </div>
      </div>

      <InlineConfirmAction
        idleLabel="取消"
        confirmLabel="确认取消"
        icon={<X className="size-3" />}
        busy={busy}
        onConfirm={() => onCancel(item.id)}
      />
    </article>
  );
}

function AutomationsDialogBody({
  data,
  isPending,
  isFetching,
  isError,
  error,
  onRefetch,
  onClose,
}: {
  data: AutomationsResponse | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  onRefetch: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("routines");
  const mutations = useAutomationMutations();
  const summary = summarizeAutomations(data);

  const busyRoutineId =
    (mutations.pause.isPending ? mutations.pause.variables : null) ??
    (mutations.resume.isPending ? mutations.resume.variables : null) ??
    (mutations.runNow.isPending ? mutations.runNow.variables : null) ??
    (mutations.removeRoutine.isPending ? mutations.removeRoutine.variables : null);

  const busyWatcherId = mutations.stop.isPending ? mutations.stop.variables : null;
  const busyReminderId = mutations.cancel.isPending ? mutations.cancel.variables : null;

  const tabs: {
    id: TabId;
    label: string;
    count: number;
    dot?: "alert" | "digest" | null;
  }[] = [
    {
      id: "routines",
      label: "定时任务",
      count: summary.routineTotalCount,
      dot: data?.routines.items.some(isRoutineUnhealthy) ? "alert" : null,
    },
    {
      id: "watchers",
      label: "监控任务",
      count: summary.watcherTotalCount,
      dot: data?.watchers.items.some(isWatcherUnhealthy)
        ? "alert"
        : summary.hasDigest
          ? "digest"
          : null,
    },
    {
      id: "reminders",
      label: "提醒",
      count: summary.reminderCount,
      dot: null,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
            <CalendarClock className="size-4 text-primary" />
            <span>任务与监控</span>
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
            查看与控制后台定时任务、外部监控和一次性提醒
          </DialogDescription>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onRefetch}
            disabled={isFetching}
            className="size-8 rounded-full text-muted-foreground hover:text-foreground"
            aria-label="刷新任务列表"
            title="刷新"
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            className="size-8 rounded-full text-muted-foreground hover:text-foreground"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Segmented Tab Bar */}
      <div className="px-5 pb-3">
        <div
          role="tablist"
          aria-label="任务分类"
          className="grid grid-cols-3 gap-1 rounded-full bg-muted/65 p-1"
        >
          {tabs.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-all",
                  selected
                    ? "bg-card text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="truncate">{item.label}</span>
                <span
                  className={cn(
                    "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.2 text-[11px] tabular-nums",
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "bg-background/60 text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
                {item.dot === "alert" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label="有异常" />
                )}
                {item.dot === "digest" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="有待发简报" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        ) : isError && !data ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-border/80 bg-muted/25 px-5 py-10 text-center">
            <AlertTriangle className="mb-2 size-6 text-destructive" />
            <p className="text-sm font-medium text-foreground">加载任务列表失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{userFacingMessage(error)}</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onRefetch}
              className="mt-4 rounded-full px-4 text-xs"
            >
              重试
            </Button>
          </div>
        ) : tab === "routines" ? (
          <div className="space-y-3">
            {data?.routines.paused && (
              <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>服务端当前开启了全局定时任务暂停（ROUTINES_PAUSED），新运行暂不会派发。</span>
              </div>
            )}
            {!data || data.routines.items.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="size-5" />}
                title="还没有定时任务"
                description="周期性巡检、每日早报或固定通知都可以通过对话直接创建。"
                examples={[
                  "每天早上 9 点帮我整理过去 24 小时的 AI 领域重要动态",
                  "每周五 18:00 提醒我整理下周工作优先级",
                ]}
                onBackToChat={onClose}
              />
            ) : (
              data.routines.items.map((routine) => (
                <RoutineCard
                  key={routine.id}
                  item={routine}
                  globalPaused={data.routines.paused}
                  onPause={(id) => mutations.pause.mutate(id)}
                  onResume={(id) => mutations.resume.mutate(id)}
                  onRunNow={(id) => mutations.runNow.mutate(id)}
                  onDelete={(id) => mutations.removeRoutine.mutate(id)}
                  busyId={busyRoutineId}
                />
              ))
            )}
          </div>
        ) : tab === "watchers" ? (
          <div className="space-y-3">
            {data && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Radar className="size-3.5 text-primary" />
                  <span>
                    免打扰 {data.watchers.quietHours ?? "未开启"} · 每日简报{" "}
                    {data.watchers.digestTime}
                  </span>
                </span>
                <span className="text-[11px]">{data.watchers.timezone}</span>
              </div>
            )}

            <WatchDigestBanner
              items={data?.watchers.digest.items ?? []}
              flushing={mutations.flushDigest.isPending}
              onFlush={() => mutations.flushDigest.mutate()}
            />

            {!data || data.watchers.items.length === 0 ? (
              <EmptyState
                icon={<Radar className="size-5" />}
                title="还没有外部监控"
                description="支持监控 RSS 订阅、X 账号以及 GitHub CI / PR，由 AI 自动筛选降噪。"
                examples={[
                  "帮我监控 https://openai.com/news/rss.xml，只关注新模型发布",
                  "盯一下 NaoYUN77/Aster 仓库的 CI 构建结果",
                ]}
                onBackToChat={onClose}
              />
            ) : (
              data.watchers.items.map((watcher) => (
                <WatcherCard
                  key={watcher.id}
                  item={watcher}
                  timezone={data.watchers.timezone}
                  onStop={(id) => mutations.stop.mutate(id)}
                  busy={busyWatcherId === watcher.id}
                />
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {!data || data.reminders.items.length === 0 ? (
              <EmptyState
                icon={<Bell className="size-5" />}
                title="没有待触发的提醒"
                description="一次性定点提醒会在到期时主动推送到主对话。"
                examples={[
                  "明天上午 10 点提醒我发版本公告",
                  "20 分钟后提醒我看一下 CI 是否跑完",
                ]}
                onBackToChat={onClose}
              />
            ) : (
              data.reminders.items.map((reminder) => (
                <ReminderCard
                  key={reminder.id}
                  item={reminder}
                  onCancel={(id) => mutations.cancel.mutate(id)}
                  busy={busyReminderId === reminder.id}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Subtle Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-border/70 bg-muted/25 px-5 py-2.5 text-[11px] text-muted-foreground">
        <span>新建或修改任务？直接在主对话告诉 Aster 即可</span>
        {summary.alertCount > 0 && (
          <span className="font-medium text-destructive">
            {summary.alertCount} 项需要关注
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 主对话页右上角悬浮胶囊 + 任务与监控弹窗：
 * - 始终可见，徽标仅统计运行中的定时任务 + 活跃监控 + 待触发提醒；
 * - 异常优先标红/橙点，无异常但有待发简报时标主色圆点；
 * - 打开弹窗时立即触发一次最新数据拉取。
 */
export function ChatAutomationsTrigger({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const query = useAutomationsQuery();
  const summary = summarizeAutomations(query.data);

  useEffect(() => {
    if (open) {
      void query.refetch();
    }
    // 仅在弹窗由关转开时即时拉取，避免 query 引用变化导致死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const statusDot = summary.hasAlert
    ? { className: "bg-destructive", title: `${summary.alertCount} 项任务异常` }
    : summary.hasDigest
      ? { className: "bg-primary", title: `${summary.digestCount} 条待发简报` }
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          summary.activeCount > 0
            ? `任务与监控（${summary.activeCount} 个活跃项）`
            : "任务与监控"
        }
        title={statusDot?.title ?? "查看定时任务、监控与提醒"}
        className={cn(
          "pointer-events-auto relative inline-flex items-center justify-center rounded-full transition-all active:scale-95",
          compact
            ? "h-11 gap-1.5 bg-secondary px-3 text-foreground"
            : "h-9 gap-1.5 border border-border/80 bg-card/90 px-3 text-xs font-medium text-foreground shadow-xs backdrop-blur-md hover:border-border hover:bg-card",
        )}
      >
        <span className="relative inline-flex items-center justify-center">
          <CalendarClock className={cn(compact ? "size-4" : "size-3.5", "text-primary")} />
          {statusDot && (
            <span
              className={cn(
                "absolute -right-1 -top-1 size-2 rounded-full ring-2 ring-card",
                statusDot.className,
              )}
              aria-hidden
            />
          )}
        </span>
        {!compact && <span>任务</span>}
        {summary.activeCount > 0 && (
          <span
            className={cn(
              "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
              compact
                ? "bg-card text-foreground"
                : "bg-accent text-accent-foreground",
            )}
          >
            {summary.activeCount}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {isDesktop ? (
          <DialogContent
            hideClose
            className="flex max-h-[82vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
          >
            <AutomationsDialogBody
              data={query.data}
              isPending={query.isPending}
              isFetching={query.isFetching}
              isError={query.isError}
              error={query.error}
              onRefetch={() => void query.refetch()}
              onClose={() => setOpen(false)}
            />
          </DialogContent>
        ) : (
          <SheetContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0">
            <AutomationsDialogBody
              data={query.data}
              isPending={query.isPending}
              isFetching={query.isFetching}
              isError={query.isError}
              error={query.error}
              onRefetch={() => void query.refetch()}
              onClose={() => setOpen(false)}
            />
          </SheetContent>
        )}
      </Dialog>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AUTOMATIONS_QUERY_ROOT,
  cancelReminder,
  deleteRoutine,
  flushWatchDigest,
  getAutomations,
  pauseRoutine,
  resumeRoutine,
  runRoutineNow,
  stopWatcher,
  type AutomationsResponse,
  type RoutineItem,
  type WatcherItem,
} from "@/api/automations";
import { userFacingMessage } from "@/api/errors";
import { useAuthStore } from "@/store/auth";
import { useConnectionStore } from "@/store/connection";

export type AutomationsSummary = {
  /** 运行中的定时任务 + 活跃监控 + 待触发提醒（已暂停不计入）。 */
  activeCount: number;
  activeRoutineCount: number;
  routineTotalCount: number;
  activeWatcherCount: number;
  watcherTotalCount: number;
  reminderCount: number;
  digestCount: number;
  alertCount: number;
  hasAlert: boolean;
  hasDigest: boolean;
};

export function isRoutineUnhealthy(item: RoutineItem): boolean {
  return item.consecutiveFailures > 0 || (item.lastError !== null && item.lastError !== "");
}

export function isWatcherUnhealthy(item: WatcherItem): boolean {
  return (
    item.source.status === "error" ||
    item.source.status === "backoff" ||
    (item.source.lastError !== null && item.source.lastError !== "")
  );
}

export function summarizeAutomations(data: AutomationsResponse | undefined): AutomationsSummary {
  if (!data) {
    return {
      activeCount: 0,
      activeRoutineCount: 0,
      routineTotalCount: 0,
      activeWatcherCount: 0,
      watcherTotalCount: 0,
      reminderCount: 0,
      digestCount: 0,
      alertCount: 0,
      hasAlert: false,
      hasDigest: false,
    };
  }
  const activeRoutineCount = data.routines.items.filter((r) => r.status === "active").length;
  const activeWatcherCount = data.watchers.items.filter((w) => w.status === "active").length;
  const reminderCount = data.reminders.items.filter(
    (r) => r.status === "pending" || r.status === "queued" || r.status === "sending",
  ).length;
  const digestCount = data.watchers.digest.items.length;

  const routineAlerts = data.routines.items.filter(isRoutineUnhealthy).length;
  const watcherAlerts = data.watchers.items.filter(isWatcherUnhealthy).length;
  const alertCount = routineAlerts + watcherAlerts;

  return {
    activeCount: activeRoutineCount + activeWatcherCount + reminderCount,
    activeRoutineCount,
    routineTotalCount: data.routines.items.length,
    activeWatcherCount,
    watcherTotalCount: data.watchers.items.length,
    reminderCount,
    digestCount,
    alertCount,
    hasAlert: alertCount > 0,
    hasDigest: digestCount > 0,
  };
}

export function automationsQueryKey(baseUrl: string) {
  return [AUTOMATIONS_QUERY_ROOT, baseUrl] as const;
}

export function useAutomationsQuery() {
  const status = useAuthStore((s) => s.status);
  const baseUrl = useConnectionStore((s) => s.baseUrl);

  return useQuery({
    queryKey: automationsQueryKey(baseUrl),
    queryFn: getAutomations,
    enabled: status === "authenticated" && baseUrl !== "",
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function useAutomationMutations() {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: automationsQueryKey(baseUrl) });

  const pause = useMutation({
    mutationFn: (id: number) => pauseRoutine(id),
    onSuccess: () => {
      toast.success("定时任务已暂停");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const resume = useMutation({
    mutationFn: (id: number) => resumeRoutine(id),
    onSuccess: () => {
      toast.success("定时任务已恢复");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const runNow = useMutation({
    mutationFn: (id: number) => runRoutineNow(id),
    onSuccess: () => {
      toast.success("已加入立即执行队列");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const removeRoutine = useMutation({
    mutationFn: (id: number) => deleteRoutine(id),
    onSuccess: () => {
      toast.success("定时任务已删除");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const stop = useMutation({
    mutationFn: (id: number) => stopWatcher(id),
    onSuccess: () => {
      toast.success("已停止该监控任务");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const flushDigest = useMutation({
    mutationFn: () => flushWatchDigest(),
    onSuccess: (res) => {
      if (res.count === 0) {
        toast.info("当前没有待推送的监控简报");
      } else {
        toast.success(`已将 ${res.count} 条监控动态汇总推送到主对话`);
      }
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => cancelReminder(id),
    onSuccess: () => {
      toast.success("提醒已取消");
      void invalidate();
    },
    onError: (err) => toast.error(userFacingMessage(err)),
  });

  return {
    pause,
    resume,
    runNow,
    removeRoutine,
    stop,
    flushDigest,
    cancel,
  };
}

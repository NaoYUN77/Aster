import { describe, expect, it } from "vitest";
import type { AutomationsResponse } from "@/api/automations";
import {
  formatErrorCode,
  formatIntervalSec,
  formatRelativeTime,
  formatSchedule,
  watchKindLabel,
} from "./format";
import { summarizeAutomations } from "./use-automations";

function baseResponse(): AutomationsResponse {
  return {
    routines: {
      enabled: true,
      paused: false,
      items: [
        {
          id: 1,
          chatId: "owner",
          title: "每日简报",
          timezone: "Asia/Shanghai",
          mode: "agent",
          brief: "总结动态",
          text: null,
          delivery: "report",
          status: "active",
          conversationId: 1,
          consecutiveFailures: 0,
          lastError: null,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-23T00:00:00.000Z",
          schedule: {
            routineId: 1,
            kind: "daily",
            spec: { kind: "daily", at: "09:00" },
            nextDueAt: "2026-11-24T01:00:00.000Z",
            lastRunAt: null,
          },
          recentRuns: [],
        },
        {
          id: 2,
          chatId: "owner",
          title: "已暂停任务",
          timezone: "Asia/Shanghai",
          mode: "notify",
          brief: null,
          text: "周报",
          delivery: "always",
          status: "paused",
          conversationId: null,
          consecutiveFailures: 0,
          lastError: null,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-23T00:00:00.000Z",
          schedule: {
            routineId: 2,
            kind: "weekly",
            spec: { kind: "weekly", days: [5], at: "18:00" },
            nextDueAt: "2026-11-27T10:00:00.000Z",
            lastRunAt: null,
          },
          recentRuns: [],
        },
      ],
    },
    watchers: {
      enabled: true,
      quietHours: "23:00-08:00",
      digestTime: "08:30",
      timezone: "Asia/Shanghai",
      items: [
        {
          id: 10,
          chatId: "owner",
          threadTs: null,
          kind: "feed",
          target: "https://example.com/rss.xml",
          label: "AI 博客",
          status: "active",
          maxEventsPerHour: 10,
          deliveryMode: "triage",
          triagePrompt: "仅关注模型发布",
          createdAt: "2026-11-20T00:00:00.000Z",
          stoppedAt: null,
          source: {
            id: 100,
            watcherId: 10,
            kind: "feed",
            location: "https://example.com/rss.xml",
            mode: "poll",
            status: "backoff",
            intervalSec: 900,
            nextCheckAt: "2026-11-23T16:00:00.000Z",
            reconcileAt: null,
            failures: 2,
            lastError: "WATCH_RATE_LIMITED",
            lastCheckAt: "2026-11-23T15:00:00.000Z",
          },
        },
      ],
      digest: {
        items: [
          {
            id: 20,
            watcherId: 10,
            eventId: 30,
            chatId: "owner",
            threadTs: null,
            text: "新动态",
            status: "queued_digest",
            attempts: 1,
            createdAt: "2026-11-23T15:10:00.000Z",
          },
        ],
      },
    },
    reminders: {
      enabled: true,
      items: [
        {
          id: 30,
          chatId: "owner",
          ownerId: "owner",
          content: "发版本公告",
          dueAt: "2026-11-24T02:00:00.000Z",
          timezone: "Asia/Shanghai",
          createdAt: "2026-11-23T10:00:00.000Z",
          status: "pending",
          attempts: 0,
          messageId: null,
          sentAt: null,
          failureCode: null,
        },
      ],
    },
  };
}

describe("summarizeAutomations", () => {
  it("counts only active routines, active watchers, and pending reminders", () => {
    const summary = summarizeAutomations(baseResponse());
    // 1 active routine (paused excluded) + 1 active watcher + 1 pending reminder = 3
    expect(summary.activeCount).toBe(3);
    expect(summary.activeRoutineCount).toBe(1);
    expect(summary.routineTotalCount).toBe(2);
    expect(summary.activeWatcherCount).toBe(1);
    expect(summary.reminderCount).toBe(1);
    expect(summary.digestCount).toBe(1);
    expect(summary.alertCount).toBe(1);
    expect(summary.hasAlert).toBe(true);
    expect(summary.hasDigest).toBe(true);
  });

  it("returns zeroed summary when data is undefined", () => {
    const summary = summarizeAutomations(undefined);
    expect(summary.activeCount).toBe(0);
    expect(summary.hasAlert).toBe(false);
    expect(summary.hasDigest).toBe(false);
  });
});

describe("automations formatters", () => {
  it("formats daily, weekly, and interval schedules", () => {
    expect(formatSchedule({ kind: "daily", at: "09:00" })).toBe("每天 09:00");
    expect(formatSchedule({ kind: "weekly", days: [1, 5], at: "18:00" })).toBe(
      "每周一、周五 18:00",
    );
    expect(formatSchedule({ kind: "every", minutes: 30 })).toBe("每 30 分钟");
    expect(formatSchedule({ kind: "every", minutes: 120, from: "09:00", to: "21:00" })).toBe(
      "每 2 小时（09:00–21:00）",
    );
  });

  it("formats intervals, relative times, watch kinds, and error codes", () => {
    expect(formatIntervalSec(900)).toBe("每 15 分钟");
    expect(formatIntervalSec(3600)).toBe("每 1 小时");
    expect(watchKindLabel("github_run")).toBe("GitHub CI");
    expect(formatErrorCode("WATCH_RATE_LIMITED")).toContain("源站限流");

    const now = Date.parse("2026-11-23T12:00:00.000Z");
    expect(formatRelativeTime("2026-11-23T12:15:00.000Z", now)).toBe("15 分钟后");
    expect(formatRelativeTime("2026-11-23T10:00:00.000Z", now)).toBe("2 小时前");
  });
});

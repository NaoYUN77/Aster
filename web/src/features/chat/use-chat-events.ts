import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { getQueue } from "@/api/client";
import { AUTOMATIONS_QUERY_ROOT } from "@/api/automations";
import { CONNECTORS_QUERY_ROOT } from "@/api/connectors";
import { refreshConnectorsFromServer } from "@/features/connectors/connector-refresh";
import { parseServerEvent } from "@/api/events";
import { errorText, toApiError } from "@/api/errors";
import { subscribeEvents, type ServerEvent } from "@/api/sse";
import type { ModelsResponse } from "@/api/types";
import { consumeLocalSelection } from "@/features/models/selection-origin";
import { modelsQueryKey } from "@/features/models/use-models";
import { hostMessageTitle, isAppInForeground, truncateSummary } from "@/lib/notifications";
import { useAuthStore } from "@/store/auth";
import { useApprovalStore } from "@/store/approvals";
import { useChatStore } from "@/store/chat";
import { useSubagentStore } from "@/store/subagents";
import { useConnectionStore } from "@/store/connection";
import { useCredentialStore } from "@/store/credential";
import { useNotificationStore } from "@/store/notifications";
import { reduceQueue } from "./queue-state";

/**
 * 连接 /api/v1/events 并把事件写进本地聊天状态。
 * 断线重连后重新拉历史 + 模型，不依赖事件回放。
 */
export function useChatEvents(): void {
  const status = useAuthStore((state) => state.status);
  const token = useAuthStore((state) => state.token);
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const setSseState = useChatStore((state) => state.setSseState);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (status !== "authenticated" || !token || baseUrl === "") {
      setSseState("closed");
      return;
    }

    const controller = new AbortController();
    const timers = new Set<number>();
    let openedOnce = false;
    let unauthorizedNotified = false;
    // snapshot.queue / queue.changed 比兜底 GET 新；兜底结果不能反过来覆盖它们。
    let snapshotQueueSeen = false;
    let queueEventSeen = false;

    const refreshQueue = () => {
      void getQueue()
        .then(({ items }) => {
          if (!snapshotQueueSeen && !queueEventSeen) {
            useChatStore.getState().setQueueFromServer(items);
          }
        })
        .catch(() => {
          // 旧服务端没有队列接口时静默降级，SSE 事件仍会驱动本地队列。
        });
    };

    const historyKey = ["messages", baseUrl] as const;
    const modelKey = modelsQueryKey(baseUrl);

    const invalidateHistory = (delay = 250) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        void queryClient.invalidateQueries({ queryKey: historyKey });
      }, delay);
      timers.add(timer);
    };

    const handle = (raw: ServerEvent) => {
      const event = parseServerEvent(raw.event, raw.data);
      const chat = useChatStore.getState();

      switch (event.type) {
        case "snapshot": {
          if (event.activeRequest) {
            const activeStatus =
              event.activeRequest.status === "queued" ? "queued" : "running";
            chat.setActive(
              event.activeRequest.requestId,
              activeStatus,
              event.activeRequest.clientMessageId ?? null,
            );
            chat.updateByRequestId(event.activeRequest.requestId, {
              status: activeStatus,
            });
            if (event.activeRequest.clientMessageId) {
              chat.updateOutgoing(event.activeRequest.clientMessageId, {
                requestId: event.activeRequest.requestId,
                status: activeStatus,
              });
            }
          } else {
            chat.setActive(null, null, null);
          }
          if (event.queue !== undefined) {
            snapshotQueueSeen = true;
            chat.setQueueFromServer(event.queue);
          }
          if (event.pendingApprovals !== undefined) {
            useApprovalStore.getState().setAll(event.pendingApprovals);
          }
          if (event.activeSubagents !== undefined) {
            useSubagentStore.getState().setAll(event.activeSubagents);
          }
          break;
        }

        case "queue.changed": {
          queueEventSeen = true;
          // 服务端队列是权威快照：既清掉 promote loading，也在这里把
          // 被 abort/promote 竞争退回排队的插话复原为普通 queued。
          chat.setQueueFromServer(event.items);
          break;
        }

        case "request.queued": {
          const state = useChatStore.getState();
          state.updateOutgoing(event.clientMessageId, {
            requestId: event.requestId,
            status: "queued",
          });
          if (!state.activeRequestId) {
            state.setActive(event.requestId, "queued", event.clientMessageId);
          }
          break;
        }

        case "request.running": {
          const state = useChatStore.getState();
          state.setQueue(reduceQueue(state.queue, event));
          state.clearPromoting(event.requestId);
          const outgoing = state.outgoing.find(
            (item) => item.requestId === event.requestId,
          );
          state.updateByRequestId(event.requestId, { status: "running" });
          state.setActive(
            event.requestId,
            "running",
            outgoing?.clientMessageId ?? null,
          );
          break;
        }

        case "request.done": {
          const state = useChatStore.getState();
          state.addLiveMessage(event.message);
          state.setUsage(event.message.id, event.usage);
          state.updateByRequestId(event.requestId, { status: "done" });
          if (state.activeRequestId === event.requestId) {
            state.setActive(null, null, null);
          }
          void useNotificationStore.getState().notify({
            priority: "completion",
            cue: "success",
            title: "Aster 已回复",
            body: event.message.text || "收到一条新回复",
            tag: `reply:${event.requestId}`,
          });
          invalidateHistory(200);
          void queryClient.invalidateQueries({ queryKey: [AUTOMATIONS_QUERY_ROOT] });
          break;
        }

        case "request.failed": {
          const state = useChatStore.getState();
          state.updateByRequestId(event.requestId, { status: "failed" });
          const message = errorText(event.code, event.message);
          state.setFailure(event.requestId, {
            code: event.code,
            message: event.message,
          });
          if (state.activeRequestId === event.requestId) {
            state.setActive(null, null, null);
          }
          toast.error(message);
          void useNotificationStore.getState().notify({
            priority: "completion",
            cue: "error",
            title: "Aster 回复失败",
            body: message,
            tag: `fail:${event.requestId}`,
          });
          invalidateHistory(200);
          break;
        }

        case "request.aborted": {
          const state = useChatStore.getState();
          const queued =
            state.queue.find((item) => item.requestId === event.requestId) ??
            state.outgoing.find(
              (item) =>
                item.requestId === event.requestId && item.status === "queued",
            );
          state.setQueue(reduceQueue(state.queue, event));
          state.clearPromoting(event.requestId);
          if (queued) {
            // 取消排队中的消息：整条从会话里消失，不留下“已停止”气泡。
            state.removeOutgoing(queued.clientMessageId);
          } else {
            state.updateByRequestId(event.requestId, { status: "aborted" });
          }
          if (state.activeRequestId === event.requestId) {
            state.setActive(null, null, null);
          }
          invalidateHistory(200);
          break;
        }

        case "request.steered": {
          const state = useChatStore.getState();
          const local = state.outgoing.find(
            (item) => item.clientMessageId === event.clientMessageId,
          );
          if (local) {
            // 本端刚发出的插话：只补上 steerId/标记，不重复插一条 user 消息。
            state.updateOutgoing(local.clientMessageId, {
              requestId: event.steerId,
              steer: true,
            });
          } else {
            // 其他端插话：插一条临时 user 行，历史刷新后由 durable 行接管。
            state.addLiveMessage({
              id: `steer:${event.steerId}`,
              role: "user",
              text: event.text,
              createdAt: event.createdAt,
              status: "complete",
              requestId: event.steerId,
              clientMessageId: event.clientMessageId,
              model: null,
              errorCode: null,
              tool: null,
            });
          }
          break;
        }

        case "steer.done": {
          // 按 message.id 合并；不清理 activeRequestId，原请求的
          // request.done / request.failed 仍然负责收尾。
          useChatStore.getState().addLiveMessage(event.message);
          invalidateHistory(200);
          break;
        }

        case "connector.changed": {
          // 连接状态以服务端为准：任一端授权/断开后，本端重新拉取列表；
          // 不对系统浏览器做任何操作。
          void refreshConnectorsFromServer(queryClient, baseUrl);
          break;
        }

        case "host.message": {
          const source = event.source ?? event.message.hostSource ?? undefined;
          useChatStore.getState().addLiveMessage({
            ...event.message,
            ...(source ? { hostSource: source } : {}),
          });
          const title = hostMessageTitle(source);
          const body = event.message.text || "收到一条新提醒";
          if (isAppInForeground()) {
            toast(title, {
              description: truncateSummary(body, 120),
              duration: 8_000,
              action: {
                label: "查看对话",
                onClick: () => navigate("/"),
              },
            });
          }
          void useNotificationStore.getState().notify({
            priority: "high",
            cue: "attention",
            title,
            body,
            tag: `host:${event.message.id}`,
          });
          invalidateHistory(200);
          void queryClient.invalidateQueries({ queryKey: [AUTOMATIONS_QUERY_ROOT] });
          break;
        }

        case "credential.request": {
          const credentials = useCredentialStore.getState();
          const isNew = credentials.pending?.requestId !== event.request.requestId;
          credentials.setPending(event.request);
          if (isNew) {
            void useNotificationStore.getState().notify({
              priority: "high",
              cue: "attention",
              title: "需要凭据授权",
              body: `${event.request.connector.name} · ${event.request.tool}`,
              tag: `cred:${event.request.requestId}`,
            });
          }
          break;
        }

        case "approval.requested": {
          const approvals = useApprovalStore.getState();
          const isNew = !approvals.pending.some((item) => item.id === event.approval.id);
          approvals.upsert(event.approval);
          if (isNew) {
            const caller =
              event.approval.caller.kind === "main"
                ? "Main Agent"
                : `Sub-agent (${event.approval.caller.subagentId})`;
            void useNotificationStore.getState().notify({
              priority: "high",
              cue: "attention",
              title: "需要你审批",
              body: `${caller} · ${event.approval.toolName}（请进入应用查看详情）`,
              tag: `approval:${event.approval.id}`,
            });
          }
          break;
        }

        case "approval.resolved": {
          useApprovalStore.getState().remove(event.approval.id);
          break;
        }

        case "subagent.updated": {
          const prev = useSubagentStore
            .getState()
            .items.find((item) => item.id === event.subagent.id);
          useSubagentStore.getState().upsert(event.subagent);
          const wasActive =
            prev === undefined ||
            prev.status === "running" ||
            prev.status === "waiting_approval";
          if (
            wasActive &&
            (event.subagent.status === "completed" || event.subagent.status === "failed")
          ) {
            void useNotificationStore.getState().notify({
              priority: "completion",
              cue: event.subagent.status === "failed" ? "error" : "success",
              title:
                event.subagent.status === "failed" ? "子任务执行失败" : "子任务已完成",
              body: event.subagent.task,
              tag: `subagent:${event.subagent.id}`,
            });
          }
          break;
        }

        case "model.changed": {
          const local = consumeLocalSelection();
          const cached = queryClient.getQueryData<ModelsResponse>(modelKey);
          if (!local && cached && cached.current.id !== event.current.id) {
            toast.info(`模型已切换为 ${event.current.label}`, {
              description: "来自其他端",
            });
          }
          void queryClient.invalidateQueries({ queryKey: modelKey });
          useChatStore.getState().bumpModelVersion();
          break;
        }

        default:
          break;
      }
    };

    void subscribeEvents({
      baseUrl,
      token,
      signal: controller.signal,
      onState: setSseState,
      onEvent: handle,
      onOpen: () => {
        snapshotQueueSeen = false;
        queueEventSeen = false;
        refreshQueue();
        if (openedOnce) {
          void queryClient.invalidateQueries({ queryKey: historyKey });
          void queryClient.invalidateQueries({ queryKey: modelKey });
          // 重连期间可能错过 connector.changed，重连后对齐一次。
          void queryClient.invalidateQueries({
            queryKey: [CONNECTORS_QUERY_ROOT],
          });
        }
        openedOnce = true;
      },
      onUnauthorized: () => {
        if (unauthorizedNotified) return;
        unauthorizedNotified = true;
        toast.error("登录已失效，请重新登录");
        void useAuthStore.getState().invalidate();
      },
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const apiError = toApiError(error);
      if (apiError.status === 401) return;
      toast.error(apiError.message);
    });

    return () => {
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, [status, token, baseUrl, queryClient, setSseState]);
}

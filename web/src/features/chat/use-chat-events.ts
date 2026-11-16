import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { parseServerEvent } from "@/api/events";
import { errorText, toApiError } from "@/api/errors";
import { subscribeEvents, type ServerEvent } from "@/api/sse";
import type { ModelsResponse } from "@/api/types";
import { consumeLocalSelection } from "@/features/models/selection-origin";
import { modelsQueryKey } from "@/features/models/use-models";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import { useConnectionStore } from "@/store/connection";

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

  useEffect(() => {
    if (status !== "authenticated" || !token || baseUrl === "") {
      setSseState("closed");
      return;
    }

    const controller = new AbortController();
    const timers = new Set<number>();
    let openedOnce = false;
    let unauthorizedNotified = false;

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
          invalidateHistory(200);
          break;
        }

        case "request.failed": {
          const state = useChatStore.getState();
          state.updateByRequestId(event.requestId, { status: "failed" });
          state.setFailure(event.requestId, {
            code: event.code,
            message: event.message,
          });
          if (state.activeRequestId === event.requestId) {
            state.setActive(null, null, null);
          }
          toast.error(errorText(event.code, event.message));
          invalidateHistory(200);
          break;
        }

        case "request.aborted": {
          const state = useChatStore.getState();
          state.updateByRequestId(event.requestId, { status: "aborted" });
          if (state.activeRequestId === event.requestId) {
            state.setActive(null, null, null);
          }
          invalidateHistory(200);
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
        if (openedOnce) {
          void queryClient.invalidateQueries({ queryKey: historyKey });
          void queryClient.invalidateQueries({ queryKey: modelKey });
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

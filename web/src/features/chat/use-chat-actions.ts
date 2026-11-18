import { useCallback } from "react";
import { toast } from "sonner";
import { abortRequest, sendMessage, steerRequest } from "@/api/client";
import { errorText, toApiError, userFacingMessage } from "@/api/errors";
import type { DisplayMessage } from "./use-display-messages";
import { useChatStore, type OutgoingStatus } from "@/store/chat";

export function useSendMessage() {
  const addOutgoing = useChatStore((state) => state.addOutgoing);
  const updateOutgoing = useChatStore((state) => state.updateOutgoing);

  return useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed === "") return false;

      const state = useChatStore.getState();
      const steerTarget =
        state.activeStatus === "running" ? state.activeRequestId : null;
      const clientMessageId = addOutgoing(trimmed, steerTarget !== null);

      if (steerTarget) {
        try {
          const result = await steerRequest(steerTarget, {
            clientMessageId,
            text: trimmed,
          });
          // 插话加入当前 run：requestId 使用 steerId，但不占用 activeRequestId，
          // 原请求的 request.done / request.failed 仍然负责收尾。
          updateOutgoing(clientMessageId, {
            requestId: result.steerId,
            status: "done",
            steer: true,
          });
          return true;
        } catch (error) {
          const apiError = toApiError(error);
          // 409 表示检查与提交之间请求已结束，且服务端没有写入；同 id 回退成普通发送。
          if (
            apiError.code !== "NO_ACTIVE_REQUEST" &&
            apiError.code !== "REQUEST_NOT_ACTIVE"
          ) {
            updateOutgoing(clientMessageId, {
              status: "failed",
              errorCode: apiError.code,
              errorMessage: apiError.message,
            });
            toast.error(errorText(apiError.code, apiError.message));
            return false;
          }
          if (apiError.code === "NO_ACTIVE_REQUEST") {
            const current = useChatStore.getState();
            if (current.activeRequestId === steerTarget) {
              current.setActive(null, null, null);
            }
          }
          // 回退后这是一条普通消息，不再显示插话标记。
          updateOutgoing(clientMessageId, { steer: false });
        }
      }

      try {
        const result = await sendMessage({ clientMessageId, text: trimmed });
        // SSE queued/running 与 POST 响应几乎同刻到达，事件可能先落地；
        // 此时不能无条件把状态写回 queued，否则会一直显示“排队中”直到 done。
        const current = useChatStore.getState();
        const local = current.outgoing.find(
          (item) => item.clientMessageId === clientMessageId,
        );
        let status: OutgoingStatus = "queued";
        if (
          local?.status === "done" ||
          local?.status === "failed" ||
          local?.status === "aborted"
        ) {
          status = local.status;
        } else if (
          local?.status === "running" ||
          (current.activeRequestId === result.requestId &&
            current.activeStatus === "running")
        ) {
          status = "running";
        }

        updateOutgoing(clientMessageId, {
          requestId: result.requestId,
          status,
        });
        // 已经 done/failed/aborted 的请求不能因为晚到的 POST 响应被重新激活。
        if (
          !current.activeRequestId &&
          (status === "queued" || status === "running")
        ) {
          current.setActive(result.requestId, status, clientMessageId);
        }
        return true;
      } catch (error) {
        const apiError = toApiError(error);
        updateOutgoing(clientMessageId, {
          status: "failed",
          errorCode: apiError.code,
          errorMessage: apiError.message,
        });
        toast.error(errorText(apiError.code, apiError.message));
        return false;
      }
    },
    [addOutgoing, updateOutgoing],
  );
}

export function useStopRequest() {
  const activeRequestId = useChatStore((state) => state.activeRequestId);

  return useCallback(async () => {
    if (!activeRequestId) return;
    try {
      await abortRequest(activeRequestId);
      toast.success("已停止");
    } catch (error) {
      toast.error(userFacingMessage(error));
    }
  }, [activeRequestId]);
}

export function useRetryMessage() {
  const removeOutgoing = useChatStore((state) => state.removeOutgoing);
  const send = useSendMessage();

  return useCallback(
    async (message: DisplayMessage) => {
      if (message.outgoing) {
        removeOutgoing(message.outgoing.clientMessageId);
      }
      // 重试使用新的 clientMessageId，避免与失败请求混淆。
      await send(message.text);
    },
    [removeOutgoing, send],
  );
}

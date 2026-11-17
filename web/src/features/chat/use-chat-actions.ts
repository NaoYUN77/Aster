import { useCallback } from "react";
import { toast } from "sonner";
import { abortRequest, sendMessage } from "@/api/client";
import { errorText, toApiError, userFacingMessage } from "@/api/errors";
import type { DisplayMessage } from "./use-display-messages";
import { useChatStore } from "@/store/chat";

export function useSendMessage() {
  const addOutgoing = useChatStore((state) => state.addOutgoing);
  const updateOutgoing = useChatStore((state) => state.updateOutgoing);

  return useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed === "") return false;

      const clientMessageId = addOutgoing(trimmed);
      try {
        const result = await sendMessage({ clientMessageId, text: trimmed });
        updateOutgoing(clientMessageId, {
          requestId: result.requestId,
          status: "queued",
        });
        const state = useChatStore.getState();
        if (!state.activeRequestId) {
          state.setActive(result.requestId, "queued", clientMessageId);
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

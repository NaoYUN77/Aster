import { useMemo } from "react";
import type { MessageRole, ModelRef, ModelUsage, UiMessage } from "@/api/types";
import type { OutgoingMessage, OutgoingStatus } from "@/store/chat";
import { useChatStore } from "@/store/chat";

export type DisplayStatus =
  | OutgoingStatus
  | "complete";

export type DisplayMessage = {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  status: DisplayStatus;
  requestId: string | null;
  model: ModelRef | null;
  errorCode: string | null;
  errorMessage: string | null;
  tool: { name: string; status: "done" | "failed" } | null;
  usage?: ModelUsage;
  local: boolean;
  outgoing?: OutgoingMessage;
};

const ROLE_RANK: Record<MessageRole, number> = { user: 0, assistant: 1, system: 2 };

export function useDisplayMessages(history: UiMessage[]): DisplayMessage[] {
  const live = useChatStore((state) => state.live);
  const outgoing = useChatStore((state) => state.outgoing);
  const usage = useChatStore((state) => state.usage);
  const failures = useChatStore((state) => state.failures);

  return useMemo(() => {
    const byId = new Map<string, UiMessage>();
    for (const message of history) byId.set(message.id, message);
    for (const message of Object.values(live)) {
      if (!byId.has(message.id)) byId.set(message.id, message);
    }

    const outgoingByRequest = new Map<string, OutgoingMessage>();
    for (const item of outgoing) {
      if (item.requestId) outgoingByRequest.set(item.requestId, item);
    }

    const serverRequestIds = new Set<string>();
    const items: Array<DisplayMessage & { order: number }> = [];

    for (const message of byId.values()) {
      if (message.requestId) serverRequestIds.add(message.requestId);
      // 停止/中断时服务端可能留下空的 assistant 占位，不渲染空气泡；
      // 失败消息仍需显示错误文案。
      if (
        message.role === "assistant" &&
        message.text.trim() === "" &&
        message.status !== "failed"
      ) {
        continue;
      }
      const item = outgoingByRequest.get(message.requestId ?? "");

      let status: DisplayStatus = (message.status ?? "complete") as DisplayStatus;
      if (message.role === "user" && item) status = item.status;
      if (status === "done") status = "complete";

      const failure = message.requestId ? failures[message.requestId] : undefined;
      const errorCode =
        item?.status === "failed"
          ? item.errorCode ?? failure?.code ?? null
          : message.errorCode ?? failure?.code ?? null;
      const errorMessage =
        item?.status === "failed"
          ? item.errorMessage ?? failure?.message ?? null
          : failure?.message ?? null;

      const usageInfo = message.role === "assistant" ? usage[message.id] : undefined;

      items.push({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        status,
        requestId: message.requestId ?? null,
        model: usageInfo?.actual ?? message.model ?? null,
        errorCode,
        errorMessage,
        tool: message.tool ?? null,
        usage: usageInfo,
        local: false,
        outgoing: item,
        order: items.length,
      });
    }

    for (const item of outgoing) {
      if (item.requestId && serverRequestIds.has(item.requestId)) continue;
      const failure = item.requestId ? failures[item.requestId] : undefined;
      items.push({
        id: `local:${item.clientMessageId}`,
        role: "user",
        text: item.text,
        createdAt: item.createdAt,
        status: item.status,
        requestId: item.requestId ?? null,
        model: null,
        errorCode:
          item.status === "failed"
            ? item.errorCode ?? failure?.code ?? null
            : null,
        errorMessage:
          item.status === "failed"
            ? item.errorMessage ?? failure?.message ?? null
            : null,
        tool: null,
        local: true,
        outgoing: item,
        order: items.length,
      });
    }

    items.sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        ROLE_RANK[left.role] - ROLE_RANK[right.role] ||
        left.order - right.order,
    );

    return items.map(({ order: _order, ...item }) => item);
  }, [history, live, outgoing, usage, failures]);
}

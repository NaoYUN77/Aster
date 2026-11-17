import type { MessageModel, MessageRole, ModelUsage, UiMessage } from "@/api/types";
import type { OutgoingMessage, OutgoingStatus, RequestFailure } from "@/store/chat";

export type DisplayStatus = OutgoingStatus | "complete";

export type DisplayMessage = {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  status: DisplayStatus;
  requestId: string | null;
  clientMessageId: string | null;
  model: MessageModel | null;
  errorCode: string | null;
  errorMessage: string | null;
  tool: { name: string; status: "done" | "failed" } | null;
  usage?: ModelUsage;
  local: boolean;
  outgoing?: OutgoingMessage;
};

export type DisplayState = {
  live: Record<string, UiMessage>;
  outgoing: OutgoingMessage[];
  usage: Record<string, ModelUsage>;
  failures: Record<string, RequestFailure>;
};

const ROLE_RANK: Record<MessageRole, number> = { user: 0, assistant: 1, system: 2 };

/**
 * 同一 id 的历史与实时消息合并：
 * - 历史文本是权威的，不被实时事件覆盖；
 * - 关联字段（requestId / clientMessageId）任一来源有值就保留；
 * - status/model/usage 以 live 的最终状态为准。
 */
function mergeMessage(historyMessage: UiMessage, liveMessage: UiMessage): UiMessage {
  return {
    ...historyMessage,
    text: historyMessage.text,
    requestId: historyMessage.requestId ?? liveMessage.requestId ?? null,
    clientMessageId:
      historyMessage.clientMessageId ?? liveMessage.clientMessageId ?? null,
    status: liveMessage.status ?? historyMessage.status,
    model: historyMessage.model ?? liveMessage.model ?? null,
    tool: historyMessage.tool ?? liveMessage.tool ?? null,
    errorCode: historyMessage.errorCode ?? liveMessage.errorCode ?? null,
  };
}

export function buildDisplayMessages(
  history: UiMessage[],
  { live, outgoing, usage, failures }: DisplayState,
): DisplayMessage[] {
  const byId = new Map<string, UiMessage>();
  for (const message of history) byId.set(message.id, message);
  for (const liveMessage of Object.values(live)) {
    const existing = byId.get(liveMessage.id);
    if (!existing) {
      byId.set(liveMessage.id, liveMessage);
      continue;
    }
    byId.set(liveMessage.id, mergeMessage(existing, liveMessage));
  }

  // 只收集“服务器 user 消息”的关联键。assistant 的 requestId 不能用来抑制
  // 本地 user 气泡：`$model` 命令没有 durable user entry，否则气泡会消失。
  const serverUserClientIds = new Set<string>();
  const serverUserRequestIds = new Set<string>();
  for (const message of byId.values()) {
    if (message.role !== "user") continue;
    if (message.clientMessageId) serverUserClientIds.add(message.clientMessageId);
    if (message.requestId) serverUserRequestIds.add(message.requestId);
  }

  const outgoingByRequest = new Map<string, OutgoingMessage>();
  for (const item of outgoing) {
    if (item.requestId) outgoingByRequest.set(item.requestId, item);
  }

  const items: Array<DisplayMessage & { order: number }> = [];

  for (const message of byId.values()) {
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
      clientMessageId: message.clientMessageId ?? null,
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
    // 只与服务器 user 消息去重；不能按文本或 assistant 的 requestId 猜。
    const matched =
      (item.clientMessageId !== "" && serverUserClientIds.has(item.clientMessageId)) ||
      (!!item.requestId && serverUserRequestIds.has(item.requestId));
    if (matched) continue;

    const failure = item.requestId ? failures[item.requestId] : undefined;
    items.push({
      id: `local:${item.clientMessageId}`,
      role: "user",
      text: item.text,
      createdAt: item.createdAt,
      status: item.status,
      requestId: item.requestId ?? null,
      clientMessageId: item.clientMessageId,
      model: null,
      errorCode:
        item.status === "failed" ? item.errorCode ?? failure?.code ?? null : null,
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
}

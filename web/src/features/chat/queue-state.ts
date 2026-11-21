import type { ParsedServerEvent } from "@/api/events";
import type { QueuedRequest } from "@/api/types";

/**
 * 队列的纯状态归约：
 * - `queue.changed` 用服务端快照整体替换；
 * - 请求被领取（running）或取消（aborted）时按 requestId 移除。
 */
export function reduceQueue(
  queue: QueuedRequest[],
  event: ParsedServerEvent,
): QueuedRequest[] {
  switch (event.type) {
    case "queue.changed":
      return event.items;
    case "request.running":
    case "request.aborted":
      return queue.filter((item) => item.requestId !== event.requestId);
    default:
      return queue;
  }
}

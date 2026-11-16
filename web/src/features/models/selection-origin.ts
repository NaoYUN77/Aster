/**
 * 区分“本端刚发起的模型切换”和“其他端切换”。
 * model.changed 事件通常先于 POST /models/select 的响应到达，
 * 仅靠 query cache 对比会把本端操作误判成其他端。
 */
let localSelectionAt: number | null = null;

export function markLocalSelection(): void {
  localSelectionAt = Date.now();
}

/** 消费一次本端标记；8 秒内有效。 */
export function consumeLocalSelection(): boolean {
  const marked = localSelectionAt !== null && Date.now() - localSelectionAt < 8000;
  localSelectionAt = null;
  return marked;
}

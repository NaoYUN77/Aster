export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 86_400_000;
  const diff = Math.round((startOfToday - startOfThatDay) / dayMs);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatExpiry(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

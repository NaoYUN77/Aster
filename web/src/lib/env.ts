/**
 * 开发环境默认启用 MSW mock；显式 VITE_USE_MOCK=0 可关闭。
 * 生产构建里 import.meta.env.DEV 为 false，mock 代码会被摇树移除。
 */
export const USE_MOCK =
  import.meta.env.VITE_USE_MOCK === "1" ||
  (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK !== "0");

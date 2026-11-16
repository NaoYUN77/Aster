/**
 * 生产构建替身：mock 与 MSW 不会进入 dist。
 * 真实运行时代码见 browser.ts（仅开发环境）。
 */
export async function startMockWorker(): Promise<void> {
  throw new Error("mock 未包含在生产构建中");
}

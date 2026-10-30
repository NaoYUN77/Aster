import type { Server } from "node:http";

export interface BrowserMetrics {
  memoryBytes: number;
  memoryLimitBytes: number | null;
  pids: number;
  pidsLimit: number | null;
}
export function readMetrics(root?: string): Promise<BrowserMetrics>;
export function createCdpProxy(options?: {
  upstreamPort?: number;
  metrics?: () => Promise<BrowserMetrics>;
  metricsTimeoutMs?: number;
}): { server: Server; close(): Promise<void> };

import { describe, expect, it } from "vitest";
import {
  formatCompactTokens,
  formatPercent,
  formatSourceLabel,
  formatTrendSubtitle,
  formatUsd,
  parseBudgetInput,
} from "./format";

describe("usage formatting helpers", () => {
  it("formats compact token counts across scales", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
    expect(formatCompactTokens(842)).toBe("842");
    expect(formatCompactTokens(1_000)).toBe("1k");
    expect(formatCompactTokens(41_200)).toBe("41.2k");
    expect(formatCompactTokens(128_000)).toBe("128k");
    expect(formatCompactTokens(1_420_000)).toBe("1.42M");
    expect(formatCompactTokens(1_250_000_000)).toBe("1.25B");
  });

  it("formats percentages and handles null cleanly", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0.684)).toBe("68.4%");
    expect(formatPercent(0.7, 0)).toBe("70%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("formats optional USD costs cleanly", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("—");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.84)).toBe("$1.84");
    expect(formatUsd(12.34)).toBe("$12.3");
  });

  it("maps execution sources and trend subtitles", () => {
    expect(formatSourceLabel("main")).toBe("主对话");
    expect(formatSourceLabel("subagent")).toBe("子任务");
    expect(formatSourceLabel("dreaming")).toBe("记忆整理");
    expect(formatSourceLabel("routine")).toBe("定时任务");
    expect(formatSourceLabel("compaction")).toBe("上下文压缩");
    expect(formatTrendSubtitle("1d")).toContain("3 小时");
    expect(formatTrendSubtitle("7d")).toContain("7 天");
    expect(formatTrendSubtitle("30d")).toContain("30 天");
  });

  it("parses user budget input strings safely", () => {
    expect(parseBudgetInput("")).toBeNull();
    expect(parseBudgetInput("0")).toBeNull();
    expect(parseBudgetInput("500k")).toBe(500_000);
    expect(parseBudgetInput("1.5M")).toBe(1_500_000);
    expect(parseBudgetInput("300,000")).toBe(300_000);
    expect(parseBudgetInput("-100")).toBe("invalid");
    expect(parseBudgetInput("abc")).toBe("invalid");
    expect(parseBudgetInput("2000M")).toBe("invalid");
  });
});

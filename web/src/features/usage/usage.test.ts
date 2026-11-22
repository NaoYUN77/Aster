import { describe, expect, it } from "vitest";
import {
  computeChartAxis,
  formatCompactTokens,
  formatPercent,
  formatRangeLabel,
  formatSourceLabel,
  formatTrendTitle,
  formatUsd,
  parseBudgetInput,
} from "./format";

describe("usage formatting helpers", () => {
  it("formats compact token counts with uppercase K/M/B suffixes", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
    expect(formatCompactTokens(842)).toBe("842");
    expect(formatCompactTokens(1_000)).toBe("1K");
    expect(formatCompactTokens(48_000)).toBe("48K");
    expect(formatCompactTokens(41_200)).toBe("41.2K");
    expect(formatCompactTokens(128_000)).toBe("128K");
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

  it("maps execution sources, range labels, and trend titles", () => {
    expect(formatSourceLabel("main")).toBe("对话");
    expect(formatSourceLabel("subagent")).toBe("后台子任务");
    expect(formatSourceLabel("dreaming")).toBe("记忆整理");
    expect(formatSourceLabel("routine")).toBe("定时任务");
    expect(formatSourceLabel("compaction")).toBe("上下文压缩");
    expect(formatRangeLabel("1d")).toBe("今日");
    expect(formatRangeLabel("7d")).toBe("最近 7 天");
    expect(formatRangeLabel("30d")).toBe("最近 30 天");
    expect(formatTrendTitle("1d")).toBe("分时用量");
    expect(formatTrendTitle("7d")).toBe("每日用量");
    expect(formatTrendTitle("30d")).toBe("阶段用量");
  });

  it("computes clean 4-step chart Y-axis ticks", () => {
    expect(computeChartAxis(322_000)).toEqual({
      ceiling: 400_000,
      ticks: [400_000, 300_000, 200_000, 100_000, 0],
    });
    expect(computeChartAxis(0).ticks).toEqual([4_000, 3_000, 2_000, 1_000, 0]);
  });

  it("parses user budget input strings safely", () => {
    expect(parseBudgetInput("")).toBeNull();
    expect(parseBudgetInput("0")).toBeNull();
    expect(parseBudgetInput("500K")).toBe(500_000);
    expect(parseBudgetInput("1.5M")).toBe(1_500_000);
    expect(parseBudgetInput("300,000")).toBe(300_000);
    expect(parseBudgetInput("-100")).toBe("invalid");
    expect(parseBudgetInput("abc")).toBe("invalid");
    expect(parseBudgetInput("2000M")).toBe("invalid");
  });
});

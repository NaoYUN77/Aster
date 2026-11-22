---
status: proposed
---

# Token usage is recorded in a standalone `usage.sqlite` ledger instead of reading `pi.usage`

Aster needs a dedicated `/usage` monitoring view showing live **context occupancy** for the
owner's conversation, time-series trends (`1d` / `7d` / `30d`), cache hit rates, optional
upstream cost estimates, per-source attribution (`main`, `subagent`, `dreaming`, `routine`,
`compaction`), and an optional soft **daily budget threshold** reminder—while keeping the main
conversation UI completely free of per-turn token clutter.

Although `@earendil-works/pi-durable` maintains a built-in `UsageDoc` (`pi.usage`) per
conversation, reading `pi.usage` directly cannot satisfy these requirements: it stores only
cumulative model totals with no timestamps, carries no execution-source taxonomy, records custom
compaction summaries under a synthetic `"app/summary"` key that drops the real provider/model
identity, and loses all sub-agent usage when disposable `sub_<id>.sqlite` stores are unlinked on
exit ([ADR-0005](0005-sub-agents-use-disposable-sqlite.md)).

We decided to persist every completed model call into a dedicated `usage.sqlite` **token ledger**,
fed from two host hook points: the governed `ToolRegistry`'s `GenerationTask.afterResponse` hook
(covering `main`, `subagent`, `dreaming`, and `routine`) and a dedicated callback on
`createCompactionExtension` (covering `compaction` with its actual `provider/modelId`). Cost is
recorded strictly from `AssistantMessage.usage.cost` (populated by the provider or `pi-ai`'s
catalog metadata) with no hardcoded static price table. When the owner configures a **daily budget
threshold**, crossing it for the first time in a local calendar day triggers a single soft
`host.message` reminder routed through the existing cross-platform notification pipeline without
interrupting active work.

## Considered Options

- **Querying `pi.usage` / `Harness.usage()` directly**: Zero extra SQLite database, but cannot
  render daily/weekly/monthly trends, cannot attribute sub-agent usage after unlink, and loses
  compaction's real model ID.
- **Querying Langfuse traces**: Optional external telemetry that may be disabled and currently
  skips dreaming, sub-agents, and compaction.

## Consequences

- Sub-agent runs remain cleanly disposable (`unlink` on exit) while their token consumption stays
  permanently accounted for in `usage.sqlite`.
- The frontend exposes token analytics exclusively on a dedicated `/usage` route (desktop sidebar
  and mobile navigation drawer), keeping the main conversation surface uncluttered.
- Existing `ModelUsage` routing/failover types remain untouched; token monitoring uses distinct
  `TokenUsage*` / `UsageLedger*` naming to avoid ambiguity.

# Dreaming-lite (P0)

Offline, report-only review of stored daily memory: read a segment plus the transcript entries it
cites, propose corrections/notes/index entries, and let a host validator decide what may be shown to
an owner. Nothing here writes memory, changes a profile, or calls a tool.

## Status (2026-11-20)

| Stage | State |
| --- | --- |
| P0 host path (snapshot, validation, secret scan, simulated approval, retrieval comparison, report) | **done**, scripted analyzer |
| P0 live model quality (correction precision, cost, latency) | **blocked**: the deployment `.env` holds a vault placeholder, and no eval credential was provided |
| Go/no-go for P1 | **not issued** (a live model run is required) |

`p0-scripted/` is a pipeline check, not a model result. Its numbers (91.3% precision, 4 → 19 of 20
retrieval questions) come from a deterministic scripted analyzer over a synthetic fixture. They show
that the host path works; they say nothing about how a real model behaves.

## Run

```bash
# Host-path check; no network, no real data.
npx tsx scripts/dream-p0-scripted.ts

# Unit tests, including the P0 host path.
npx tsx --test test/memory-dream.test.ts

# Live P0. Needs a usable provider key in the environment; never reads a deployment .env.
DREAM_P0_LIVE=1 DEEPSEEK_API_KEY=... npx tsx --test test/dream-p0-live.test.ts
```

The live test writes `report.json`, `report.md` and `proposals.json` under `DREAM_P0_OUT` (a fresh
`/tmp` directory by default) and stops at the `DREAM_P0_BUDGET` gate (default $0.50).

## Boundaries

- Input is synthetic (`test/dream-p0/dataset.ts`); no real transcript or daily store is copied.
- The analyzer has no tools. The output schema has no profile/preference field; an extra
  profile-looking key rejects the whole response as an injection attempt.
- Every correction must cite an existing source entry inside the segment's source range and carry
  the segment's current digest.
- Every proposed text is scanned for credential shapes and a synthetic canary; a hit drops the item
  and never logs the match.
- Approval is simulated only inside a throwaway store for the retrieval comparison. No apply path
  exists yet (that is P1, after a live go/no-go).

## Known gaps found while building P0

- `archive`/`daily` do not set file modes themselves. A local publish produced `0664` files under a
  `0775` directory; deployment relies on the volume root being `0700`. The design note that daily
  files are `0600` is not true of the code path.
- The design draft's note kind `fact` is not a daily kind. P0 uses `result` for a fact-shaped note
  and excludes `user-requirement` so a dream can never feed profile extraction.
- A correction to a `user-requirement` segment is accepted into the report but is not an apply
  candidate, matching the product rule that a dream never changes profile.

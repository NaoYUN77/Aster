# Letta-style memory for Aster (core memory + dreaming)

Status: implementation branch `feat/letta-memory`, forked from `main` at `36ee572`.
Borrows Letta's architecture, not its code: Aster keeps its own working state and daily
archive, and gains a git-backed core memory plus a background consolidation pass.

## 1. Goal

Aster is a single-owner, single-conversation personal agent. Three ideas are ported from
[Letta](https://docs.letta.com):

1. **Core memory** — a git-backed repository whose root `MEMORY.md` is injected into the system
   prompt on every turn, and that the agent edits with its ordinary tools.
2. **On-demand memory** — other files and subdirectories stay out of context and are read when
   needed.
3. **Dreaming** — a background consolidation run that reviews recent experience and updates core
   memory, without blocking the conversation.

Not ported: Letta's code, its memory blocks API, its archival vector store, or its multi-agent
model. Aster's existing working state and daily archive are unchanged.

## 2. How this fits Aster's existing memory

| Existing | Role | Relationship |
| --- | --- | --- |
| Working state (block B, `src/memory/working.ts`) | Session-scoped standing state, host-validated from transcripts | Unchanged. Not written by dreaming. |
| Daily archive (`src/memory/daily.ts`) | Append-only recall store with `memory_search` / `memory_read` | Unchanged. One of dreaming's inputs. |
| Profile (`src/memory/profile.ts`) | Derived preference profile | Unchanged. |
| **Memory core (`$DATA_DIR/memory-fs`)** | **New.** Durable, explicitly authored core memory | The only store dreaming writes. |

Revisiting whether working state should become a host-maintained section of `MEMORY.md` is a
separate project, deliberately out of scope.

## 3. Repository layout

```
$DATA_DIR/memory-fs/            # git repository, branch main
├── MEMORY.md                   # the only file injected into the prompt
├── reference/                  # read on demand
│   ├── MEMORY.md               # its index line is a signpost, not content
│   └── project-notes.md
├── skills/                     # reserved; existing skills system unchanged
└── .aster/                     # gitignored: dreaming state
```

- **`MEMORY.md` only.** Persona, the owner's profile, standing goals and constraints live as
  sections inside it. Every other file is read on demand with `read` / `bash`.
- A subdirectory is discoverable only through its own `MEMORY.md` index entry.
- `.git/`, `.aster/`, non-`*.md` files and symlinks are never rendered. The agent can still reach
  them with `bash`, the same exposure Letta has.
- The host commits dirty work at turn boundaries; `git log` is the undo path.

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_FS_ENABLED` | `1` | Master switch. `0` restores the pre-branch prompt exactly. |
| `MEMORY_FS_DIR` | `$DATA_DIR/memory-fs` | Absolute repository path. |
| `MEMORY_FS_CORE_TOKENS` | `4096` | Budget for the injected `MEMORY.md`. |
| `DREAMING_ENABLED` | `1` | Master switch for background consolidation. |
| `DREAMING_AT` | `04:00` | Nightly trigger, `HH:MM` on the 24-hour clock in `MEMORY_TIMEZONE`. |
| `DREAMING_ON_COMPACTION` | `1` | Also run after a context compaction. |
| `DREAMING_BEHAVIOR` | `auto-launch` | `auto-launch` (background write) or `reminder` (nudge only). |
| `DREAMING_DRY_RUN` | `0` | Compute and check the layout, but never merge. |
| `DREAMING_TIMEOUT_MS` | `120000` | One run's hard limit. |

There is no switch for the MEM-07 memory system itself: working state, the daily archive,
retrieval tools, compaction and the profile pipeline are always composed. A leftover
`MEMORY_ENABLED` from an older deployment is ignored and reported by name at startup; a host that
needs the pre-MEM-07 composition injects `enabled: false` into the memory config section itself.

Dreaming uses the main model chain; there is no separate dreaming model.

## 5. Runtime model

### 5.1 Injection

- `buildInstructions()` gains an optional `memoryFiles` section: the absolute directory plus the
  fenced content of `MEMORY.md`, wrapped as data, never instructions. A line that could close the
  fence is indented.
- The section is budgeted by `MEMORY_FS_CORE_TOKENS`; truncation is announced, never silent.
- On session open and before each request the host renders the section, hashes it, and calls
  `configure({ instructions })` only when the hash changed.
- Only the owner's conversation receives it. There are no member Hubs and no routine injection.

### 5.2 Tools

The agent edits memory with the ordinary `read`, `write`, `edit` and `bash` tools against the
absolute path — no dedicated memory tools, no path sandbox beyond the container. Versioning does
not intercept writes: the host commits the tree at each successful turn boundary and before a
render.

### 5.3 Dreaming

- **Trigger**: once per local date at `DREAMING_AT` (default `04:00`, interpreted in
  `MEMORY_TIMEZONE`), or after a compaction when `DREAMING_ON_COMPACTION=1`. A process that starts
  after the time catches up the missed night once; the local date is claimed when the trigger
  fires, so the same day never runs twice whatever the outcome. A trigger during a run coalesces
  into one pending run. The removed `DREAMING_TURNS` is reported by name at startup and never read.
- **Input**: the last K turns of the owner conversation plus the daily archive since the last
  run's cursor, bounded by tokens. No member Hubs exist to read.
- **Run**: one background subagent in an isolated `git worktree`, with the ordinary tools, using
  the main model. It consolidates recent experience into notes and maintains `MEMORY.md` as a
  wiki index: `## Core` for facts that must be injected every turn, `## Index` linking every note.
  The number, names and structure of notes are the model's decision.
- **Layout check**: before anything is applied, the host verifies that `MEMORY.md` exists, that
  every note is linked from `## Index`, and that every index link resolves to a note inside the
  repository. A broken layout discards the run (`layout-invalid`); there is no second model pass.
  A Core fact that evidence contradicts is demoted to a note or deleted by the dream pass itself.
- **Apply**: the host commits the worktree (actor `dreaming`), commits the live tree if dirty,
  rebases the dream commit onto the live HEAD if live advanced meanwhile, then
  `git merge --ff-only`. A rebase conflict, timeout or invalid layout discards the worktree and
  branch; the live directory is never touched and a forced merge is never used.
- **Reminder** (opt-in): a one-line "memory review due" note on the next request after the
  nightly time (or a compaction). The local date is persisted in `.aster/dreaming.json`, so the
  same day never nudges twice.
- **Dry run**: the full pipeline runs, apply is skipped; the night still counts once, and the next
  trigger is the next local date or a compaction.

### 5.4 Background execution model

Dreaming is asynchronous, not a separate daemon:

- One in-process runner. At most one run at a time, globally; triggers during a run coalesce.
- The nightly check is a process timer for `DREAMING_AT` in `MEMORY_TIMEZONE`; it fires at most
  once per local date and catches up the same date when the process starts after the time. A
  compaction can trigger a run as well. Triggers only enqueue work; nothing sits in the reply path.
- A run has one hard timeout (`DREAMING_TIMEOUT_MS`) that covers the model turn, every git
  command and apply; expiry discards the run like any other abort. One retry on a
  transient model failure, then backoff. No unbounded loops.
- State lives in `.aster/dreaming.json`: `lastNightlyDate`, last run, last applied commit, failure
  reason. Old `turnsSinceApply`/`reminderTurns` fields are read and ignored. `dreaming status`
  prints it; logs use `dreaming.*` events.
- At startup the runner prunes crashed leftovers: `git worktree prune`, then delete a
  `dreaming/*` branch only when no live worktree is registered for it.

## 6. Single-owner cleanup (same change set)

The Hub / multi-tenant isolation predates the single-owner goal and is removed here:

- `src/hubs.ts`, `HubStore`, member Hubs, per-member memory roots and workspaces, member tool
  policy, and thread forks are deleted.
- A message from anyone other than the owner is ignored and logged; no reply is sent.
- Slack thread anchors are no longer used for routing or state; replies are flat. There is one
  conversation.
- `ownerId` remains the only identity. No user keys, no multi-user directories.

## 7. Safety invariants

1. Dreaming may write any file in the memory repository, including the persona/human sections of
   `MEMORY.md` and `MEMORY.md` itself. Nothing outside the repository is writable by it.
2. Every change is committed with actor (`owner`, `agent`, `dreaming`) and reason; `git log` is
   the undo path.
3. A failed or conflicting dream run is discarded without touching the live directory.
4. Auto-launch is the default, exactly as in Letta; the host-side layout check and
   `DREAMING_DRY_RUN` are the safety rails.
5. Working memory, the derived profile pipeline, the daily archive and the existing tool set are
   unchanged.
6. Credentials are never stored in memory; the prompt says so and no tool or host path stores them.

## 8. Milestones and tests

- **M1 (PR #88)**: repository init, render, instruction refresh, turn-boundary commits, config,
  `git` in the runtime image, nine tests. Being adjusted to inject only `MEMORY.md`.
- **M2 (same PR)**: Hub/thread removal, the dreaming runner, triggers, worktree apply, the
  wiki layout check, dry run, status, and scripted fake-model tests covering trigger → worktree →
  apply, layout rejection, conflict, timeout, and the single-owner routing.
- Every step runs `npm run check` and `npm test` with no new skips.

## 9. Deliberate differences from Letta

| Letta | This branch | Why |
| --- | --- | --- |
| Several core-memory files in the prompt | One `MEMORY.md` with sections | Prompt economy; the owner asked for it. |
| Memory blocks API | Git repository + ordinary tools | Aster stores memory as files, not blocks. |
| Conversation-history search is a separate store | Existing daily archive + `memory_search` | Already implemented and tested. |
| Skills live in MemFS | Reserved directory only | Existing skills system stays authoritative. |
| Multi-agent / multi-tenant memory | Single owner, one conversation | The product is a personal agent. |
| Harness commits each edit | Host commits at turn boundaries | pi-durable's file tools cannot be intercepted per call. |

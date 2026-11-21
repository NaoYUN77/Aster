# Letta-style memory for Aster (MemFS + dreaming)

Status: implementation branch `feat/letta-memory`, forked from `main` at `36ee572`.
Planning only on this branch: no merge, no deploy, no production or test-instance changes.

## 1. Goal

Port [Letta](https://docs.letta.com)'s memory architecture onto Aster's single-owner agent:

1. **Core memory** — Markdown files at the root of a git-backed memory repository, injected into
   the system prompt on every turn.
2. **Signposts** — directories with their own `MEMORY.md` stay out of context; the agent reads
   them on demand.
3. **Dreaming** — a background reflection subagent that reviews recent conversations and updates
   memory files, triggered by a step count or by context compaction.

Reference: Letta's [Memory & dreaming](https://docs.letta.com/configuration/memory/),
[MemFS](https://docs.letta.com/concepts/memfs/), and
[Agent SDK memory](https://docs.letta.com/agent-sdk/memory/).

## 2. How this fits Aster's existing memory

Aster already has three distinct things; MemFS does not replace any of them:

| Existing | Role | Relationship |
| --- | --- | --- |
| Working state (block B, `src/memory/working.ts`) | Session-scoped standing state, host-validated from transcripts | Unchanged. Still injected through the memory projection. |
| Daily archive (`src/memory/daily.ts`) | Append-only recall store with `memory_search` / `memory_read` | Unchanged. Becomes the **recall** layer and one of dreaming's inputs. |
| Profile (`src/memory/profile.ts`) | Derived preference profile | Unchanged, and never written by dreaming. |

MemFS is the **core memory** layer: durable, explicitly authored (owner or agent), versioned, and
small enough to sit in the prompt.

## 3. Repository layout

```
$DATA_DIR/memory-fs/            # git repository, branch main
├── MEMORY.md                   # root index, in context
├── persona.md                  # in context
├── human.md                    # in context
├── <topic>.md                  # in context
├── reference/
│   ├── MEMORY.md               # index line in context, body on demand
│   └── project-notes.md
├── skills/                     # reserved (M3); existing skills system unchanged
└── .aster/                     # gitignored: dreaming state, render cache
```

Rules (mirroring Letta):

- `*.md` files at the repository root are rendered into the system prompt every turn.
- A subdirectory is in context only through its `MEMORY.md` index entry; the bodies are read with
  the memory file tools.
- `.git/`, `.aster/`, non-`*.md` files, and symlinks are never served to the model.
- Every write is a commit; history is the undo mechanism.

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_FS_ENABLED` | `1` | Master switch. `0` restores exactly the pre-branch prompt. |
| `MEMORY_FS_DIR` | `$DATA_DIR/memory-fs` | Repository path. |
| `MEMORY_FS_CORE_TOKENS` | `4096` | Budget for the rendered core section. |
| `MEMORY_FS_FILE_MAX_BYTES` | `65536` | Per-file write cap. |
| `MEMORY_FS_SEARCH_LIMIT` | `20` | Max keyword-search hits. |
| `DREAMING_TRIGGER` | `step-count` | `off` \| `step-count` \| `compaction`. |
| `DREAMING_STEP_COUNT` | `25` | Steps between dreaming runs. |
| `DREAMING_BEHAVIOR` | `reminder` | `reminder` (nudge the agent, no write) \| `auto-launch` (background write). |
| `DREAMING_REVIEW` | `1` | Second review pass over proposals before applying. |
| `DREAMING_ALLOW_PROFILE_WRITE` | `0` | Allow dreaming to modify `persona.md` / `human.md`. |

`MEMORY_FS_DIR` is resolved once at startup; a relative path is rejected.

## 5. Runtime model

### 5.1 Injection

- `buildInstructions()` gains an optional `memoryFiles` string. The rendered section is appended
  as a labelled, fenced data block: files are **data, not instructions**.
- Rendering is deterministic: root `*.md` sorted by name, `MEMORY.md` first, each file capped,
  total capped by `MEMORY_FS_CORE_TOKENS`. Truncation is announced in the section, never silent.
- On session open and before each request, the host renders the section, hashes it, and calls
  `session.configure({ agent: { instructions } })` only when the hash changed. This gives
  Letta's "files in the prompt every turn" without a write per turn.
- The base prompt (identity, tool guidance, delivery rules) is unchanged and comes first.

### 5.2 Tools

Dedicated, path-sandboxed tools rather than raw `bash`/file tools:

| Tool | Effect |
| --- | --- |
| `memory_file_list` | Root files and directory indexes. |
| `memory_file_read` | One file by path, with a byte cap. |
| `memory_file_write` | Atomic write + commit; actor recorded. |
| `memory_file_delete` | Delete + commit. |
| `memory_file_search` | Keyword search across the repository, limit applied. |

All tools reject absolute paths, `..`, `.git`, symlinks, non-Markdown targets, oversized writes,
and content matching the secret patterns already used by `src/memory/dream/validate.ts`.

### 5.3 Dreaming

- **Trigger**: after `DREAMING_STEP_COUNT` completed agent steps, or when the memory integration
  compacts the context. Counter and last-run state live in `.aster/state.json`.
- **Reminder** (default): the next request carries a short host note that memory review is due;
  nothing is written automatically.
- **Auto-launch**: a background run in an isolated `git worktree` reads the recent transcript and
  daily archive, emits strict JSON file operations (`create` / `replace` / `delete` with an
  expected digest), and the host validates every operation. Accepted operations are committed on
  the worktree branch and fast-forwarded onto `main`; a conflict discards the worktree and the
  next trigger retries.
- **Review pass** (`DREAMING_REVIEW=1`): a second model call re-reads each proposal against the
  cited transcript range and drops unsupported ones before apply.
- The background run has no tools, no network, and cannot reach the real data directory.

## 6. Safety invariants

1. Dreaming never writes `persona.md` or `human.md` unless `DREAMING_ALLOW_PROFILE_WRITE=1`.
   This is the one deliberate deviation from Letta, and it preserves Aster's rule that a
   preference profile is never built automatically.
2. The memory directory is the only writable root; sandbox escapes are tested.
3. Secrets are scanned on every write, at every entry point.
4. Every change is a commit with actor (`owner`, `agent`, `dreaming`) and trigger; `git log` is
   the undo path.
5. Auto-launch stays off by default until the owner approves it; `reminder` is the shipped
   default.
6. No change to working memory, profile, daily archive, or the existing tool set.

## 7. Milestones

- **M1 — memory core**: store, sandbox, atomic commits, render, instruction refresh, five file
  tools, config parsing, unit tests. No dreaming yet.
- **M2 — dreaming**: trigger counters, reminder path, auto-launch subagent with JSON contracts,
  review pass, worktree apply/merge, tests.
- **M3 — quality**: memory doctor (duplication, placement, token audit), explicit `/remember`
  path, optional semantic search, HTTP surface on the web branch.

Each milestone must pass `npm run check` and `npm test` with no new skips.

## 8. Explicit deviations from Letta

| Letta | This branch | Why |
| --- | --- | --- |
| Memory files editable with ordinary file tools | Dedicated sandboxed tools | Aster's file tools are bound to the workspace, not the data volume. |
| Dreaming may rewrite persona/human memory | Blocked unless a flag is set | Aster never builds a preference profile automatically. |
| Conversation-history search is a separate store | Existing daily archive + `memory_search` | Already implemented and tested; no second transcript store. |
| Skills live in MemFS | Reserved directory only | Existing skills system stays the source of truth in M1/M2. |
| `auto-launch` is a normal mode | Implemented, default `reminder` | Writes are opt-in until the owner approves. |

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
- A subdirectory is in context only through its `MEMORY.md` index entry; the bodies are read on
  demand with the ordinary file tools.
- `.git/`, `.aster/`, non-`*.md` files, and symlinks are never rendered. The agent can still reach
  them with `bash`, the same exposure Letta has.
- The host commits dirty work at turn boundaries; history is the undo mechanism.

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_FS_ENABLED` | `1` | Master switch. `0` restores exactly the pre-branch prompt. |
| `MEMORY_FS_DIR` | `$DATA_DIR/memory-fs` | Repository path. |
| `MEMORY_FS_CORE_TOKENS` | `4096` | Budget for the rendered core section. |
| `DREAMING_TRIGGER` | `step-count` | `off` \| `step-count` \| `compaction`. |
| `DREAMING_STEP_COUNT` | `25` | Steps between dreaming runs. |
| `DREAMING_BEHAVIOR` | `auto-launch` | `reminder` (nudge the agent, no write) \| `auto-launch` (background subagent writes). |
| `DREAMING_REVIEW` | `1` | Second review pass over proposals before applying. |

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

### 5.2 Memory directory and tools

Following Letta, the agent edits memory with the **ordinary tools it already has** — `read`,
`write`, `edit` and `bash` — against the absolute memory path. No dedicated `memory_file_*`
tools are registered, and no path sandbox is imposed beyond the container itself.

- The system prompt names the directory (`$MEMORY_FS_DIR`) and states that root `*.md` files are
  already included, that other files are read on demand, and that credentials must never be
  stored there.
- Versioning does not depend on intercepting writes: the host commits dirty work at turn
  boundaries (`git add -A` + commit when the tree changed) and before each render. Tool calls may
  therefore write freely, exactly as in Letta; `git log` and `git diff` remain the undo path.
- Dreaming runs get the same ordinary tools inside an isolated `git worktree`, so a background
  edit never races the live directory.

### 5.3 Dreaming

- **Trigger**: after `DREAMING_STEP_COUNT` completed agent steps, or when the memory integration
  compacts the context. Counter and last-run state live in `.aster/state.json`.
- **Auto-launch** (default, as in Letta): when a trigger fires, the host starts a background
  subagent in an isolated `git worktree`. It reads the recent transcript and daily archive with
  ordinary tools, then edits memory files — including `persona.md` and `human.md` — with the same
  `read` / `write` / `edit` / `bash` tools the live agent uses. When the run finishes, the host
  commits the worktree and fast-forwards `main`; a conflict discards the worktree and the next
  trigger retries. The live conversation is never blocked.
- **Reminder** (opt-in): the next request carries a short host note that memory review is due;
  nothing is written automatically.
- **Review pass** (`DREAMING_REVIEW=1`): a second background conversation re-reads the diff against
  the cited transcript range and drops unsupported changes before apply, mirroring Letta's
  "agent reviews before applying".
- The background run is asynchronous: it starts when a trigger fires, not inside the reply path.

### 5.4 Background execution model

Dreaming is asynchronous, not a separate daemon:

- One in-process runner per memory directory. States: `idle -> running -> idle`; at most one run
  at a time. A trigger that fires while a run is active is coalesced into a single pending run.
- The trigger check runs **after** a reply is delivered (step counter) or after compaction
  completes; it never sits in the reply path. `void runner.kick(reason).catch(log)`.
- A "step" is a completed agent request; Aster does not expose pi-durable's internal tool rounds,
  so the counter approximates Letta's step count and the documentation says so.
- A run: create `git worktree add <tmp> -b dream/<id>` from the memory repository, run one
  subagent with `cwd` = the worktree and the ordinary tools, then have the host commit the
  worktree. Live conversations never wait on it.
- The subagent's instructions: review recent transcript and daily archive; update memory files;
  `persona.md` / `human.md` are allowed; never store credentials; do not commit; the host owns
  git.
- Apply: if the live tree is dirty, commit it first, then `git merge --ff-only dream/<id>`. Any
  conflict or review rejection discards the worktree and branch and records the failure in state;
  the next trigger may retry. A failed run never touches the live directory.
- Review pass (`DREAMING_REVIEW=1`): a second background conversation reads the worktree diff and
  the cited transcript range, and may revert files or reject the run before apply.
- Timeout and output caps are enforced on the subagent; transient model failures get one retry,
  then backoff. There is no unbounded retry loop.
- `reminder` behavior instead records a one-line "memory review due" note that the next request
  includes; nothing is written.

## 6. Safety invariants

1. Dreaming may write any memory file, including `persona.md` and `human.md`, exactly as in
   Letta. The owner approved this on 2026-11-21; the previous "never touch profile" rule applied
   to the old auto-extracted preference profile, which is unchanged.
2. The memory directory is an ordinary directory inside the container; the container is the
   boundary. No path sandbox is claimed.
3. Every change is committed by the host at turn boundaries and after dreaming runs, with actor
   (`owner`, `agent`, `dreaming`) in the message; `git log` is the undo path.
4. Dreaming runs asynchronously; a failed or conflicting run is discarded without touching the
   live directory.
5. No change to working memory, the derived profile pipeline, the daily archive, or the existing
   tool set.

## 7. Milestones

- **M1 — memory core**: store, repository init, turn-boundary commits, render, instruction
  refresh, memory-path prompt section, config parsing, unit tests. No dreaming yet.
- **M2 — dreaming**: trigger counters, asynchronous auto-launch subagent using the ordinary tools
  in a worktree, review pass, merge/discard, reminder path, tests.
- **M3 — quality**: memory doctor (duplication, placement, token audit), explicit `/remember`
  path, optional semantic search, HTTP surface on the web branch.

Each milestone must pass `npm run check` and `npm test` with no new skips.

## 8. Explicit deviations from Letta

| Letta | This branch | Why |
| --- | --- | --- |
| Conversation-history search is a separate store | Existing daily archive + `memory_search` | Already implemented and tested; no second transcript store. |
| Skills live in MemFS | Reserved directory only | Existing skills system stays the source of truth in M1/M2. |
| Every tool edit is committed by the harness | Host commits dirty work at turn boundaries | Aster's `read`/`write`/`edit` belong to pi-durable and cannot be intercepted per call. |

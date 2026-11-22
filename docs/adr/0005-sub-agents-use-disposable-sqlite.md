---
status: proposed
---

# Sub-agents run in disposable per-run SQLite stores instead of forking `agent.sqlite`

Main-agent delegation needs sub-agents that can run concurrently with the owner's conversation,
carry only task-relevant context and tools, and be cleanly reclaimed when finished. Although
`@earendil-works/pi-durable@1.5.0` natively supports logical zero-copy `conversation.fork()` inside
`agent.sqlite` (and Dreaming/Routines already create ownerless conversations there), its storage is
strictly append-only with no conversation deletion API, and each SQLite store requires a single
exclusive writer (serialized in Aster by `AgentGate`).

We decided that each **sub-agent run** opens its own disposable SQLite store (`sub-<id>.sqlite`)
with a fresh harness, seeded explicitly by the main agent via `spawn_subagent` (`task`, optional
`systemPrompt`, `tools` allowlist, `cwd`, and `wait | background` mode), and returns only a
structured **sub-agent result** to the root conversation before closing and unlinking its SQLite
file. Sub-agents have no fixed archetypes. Because [ADR-0004](0004-dreaming-applies-without-git.md)
showed that bare git worktrees do not confine tools that resolve absolute paths, workspace-writing
sub-agents share the workspace under host-enforced path confinement, a single-writer workspace
mutex, and sensitive-operation approvals rather than per-run repository copies.

## Considered Options

- **Native `conversation.fork()` in `agent.sqlite`**: Zero custom storage and native crash recovery,
  but sub-agent transcripts accumulate permanently in the append-only database and contend with the
  root conversation on the single writer.
- **Custom `OverlayStorage` (disposable delta SQLite over read-only `agent.sqlite`)**: Enables both
  zero-copy context inheritance via `fork()` and clean `unlink` reclamation, but requires
  maintaining a custom 17-method `Storage` adapter (including disjoint ID minting and cross-store
  `commitSeq` semantics). Deferred as a future opt-in `inheritContext: true` mode if explicit task
  briefs prove insufficient.

## Consequences

- Reclaiming a completed or cancelled sub-agent is a single file unlink with zero bloat in
  `agent.sqlite`.
- Background sub-agents write concurrently without blocking the root conversation's `AgentGate`.
- The main agent must supply sufficient task context in `spawn_subagent` instead of relying on
  implicit full-transcript inheritance.
- Only one sub-agent may hold workspace write authority at a time until a future isolated-copy
  mechanism is needed for parallel code edits.

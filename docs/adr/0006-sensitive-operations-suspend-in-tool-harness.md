---
status: proposed
---

# Sensitive operations suspend in the tool harness and route approvals to the root conversation

Aster's existing tool governance (`src/tools.ts`, `src/github-gate.ts`) performs only synchronous
static checks, and `credential.request` broadcasts an SSE event and immediately throws rather than
pausing execution. We need runtime human-in-the-loop approval for **sensitive operations**
(destructive shell commands, writes outside the workspace, `authz: "write"` external tools, and
sub-agent workspace write escalations) across both the main agent and dynamically spawned
sub-agents.

We decided to implement a unified approval engine inside the governed tool execution layer. When
a host-enforced policy rule matches, the tool execution persists an **approval request**, pushes
it to the owner's single web entry (tagging whether the caller is the main agent or a specific
sub-agent and showing the full arguments and matched rule), and suspends only the calling execution
flow by awaiting the owner's decision (`approve once`, `approve similar for this run`, or
`deny` with an optional reason fed back to the model). The wait observes `context.abortSignal` so
owner aborts and `harness.close()` never hang, pauses the 300-second turn execution timer in favor
of an approval timeout (default 30 minutes, auto-denying on expiry), and leaves sensitive tools at
`replay: "unsafe"`.

## Considered Options

- **Model-initiated approval requests**: Rejected because the model cannot be trusted to recognize
  or declare its own high-risk actions; host-enforced rules must be the floor.
- **Cross-restart tool parking**: `@earendil-works/pi-durable@1.5.0` has no built-in primitive to
  park and resume an in-flight `tool.execute` call across process restarts. Implementing a separate
  two-phase durable state machine now would add significant complexity; relying on `replay: "unsafe"`
  to fail safe as `interrupted` on crash/restart guarantees sensitive actions are never
  auto-approved or double-executed.

## Consequences

- Both main-agent and sub-agent sensitive calls share one approval UX in the root conversation
  without blocking unrelated sub-agents or the owner's ability to abort.
- If the Aster process restarts while an approval is pending, the interrupted tool call settles
  safely as `interrupted` (effectively denied) rather than resuming automatically.
- Approval state and policy rules live in a dedicated host module, keeping `GLOSSARY.md` and the
  existing static GitHub gate cleanly separated from interactive runtime approvals.

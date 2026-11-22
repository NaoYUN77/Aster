# Aster

A single-owner personal agent. Memory, conversation and consolidation vocabulary used across the
codebase and the design docs.

## Language

### Identity and conversation

**Owner**:
The one person the agent serves. The single entry admits only the owner; there are no members,
tenants or other callers.
_Avoid_: user, member, tenant, customer

**Turn**:
One completed request and reply between the owner and the agent.
_Avoid_: message, step, round, exchange

**Conversation**:
The single durable thread of turns between the owner and the agent. Where a turn is delivered is
not part of the model; there is one conversation.
_Avoid_: session, chat, thread

**Entry**:
The one way the owner's messages reach the agent: the authenticated web endpoint. An entry carries
turns into the conversation; it is not itself a conversation, a place or a choice.
_Avoid_: channel, transport, connector, interface

### Memory

**Core memory**:
The durable wiki the owner and the agent maintain together, made of an index file, its notes, and
a small set of core facts that are in the prompt on every turn.
_Avoid_: long-term memory, profile, context

**Memory index**:
The one file of core memory that is injected on every turn: a short list of core facts plus a
soft link to every note. It is the agent's only map of what the wiki holds.
_Avoid_: table of contents, summary, index file, MEMORY.md

**Note**:
One Markdown file of core memory holding dense, abstracted facts about a single topic, read only
when the index or another note links to it. How many notes exist and what each covers is the
dream pass's decision, never a fixed layout.
_Avoid_: page, document, block, memory item

**Core facts**:
The few lines in the memory index that must be in every prompt: standing constraints, identity and
hard preferences. A fact is promoted here when it recurs or the owner insists, and demoted to a
note or deleted when evidence contradicts it.
_Avoid_: pinned facts, profile, persona

**Soft link**:
A reference from the memory index, or between notes, to another note by name. It carries no copy
of the target's content, so a note is either current or absent.
_Avoid_: hard link, embed, include

**Layout check**:
The host's structural check before a dream run applies: the index exists, every note is linked
from it, and every link resolves inside the wiki. It says nothing about whether facts are true.
_Avoid_: lint, validation, review, audit

**Activity digest**:
The day-grouped, redacted summary of durable conversation events since the last applied dream
run: user and assistant text, tool-call names with argument summaries, tool results and errors.
It is the evidence layer a dream run reads, built on demand, not a store.
_Avoid_: daily archive, transcript, history, log

**Evidence cursor**:
The entry-id watermark (`evidenceThrough`) naming the newest durable entry an applied dream run
consumed. Entry ids are global and increasing, so one watermark covers every owner conversation
after it; it is never a date string.
_Avoid_: archive cursor, checkpoint, date cursor, recall

**Live memory**:
The one memory directory the owner and the agent edit directly and the prompt reads. Every other
copy of it — a snapshot or a staging copy — is derived and never authoritative.
_Avoid_: the repository, master copy, live tree

**Snapshot**:
A full-directory capture of live memory the host takes at a turn boundary, before an apply, or
before a restore. It is the undo unit: the memory CLI lists snapshots and restores one, and a
restore keeps the tree it replaces as a snapshot of its own.
_Avoid_: commit, checkpoint, backup, version

**Working state**:
The host-derived, session-scoped summary of standing goals and open work that is injected for
the current context cycle. Maintained by the host, never by dreaming.
_Avoid_: scratchpad, short-term memory, core memory

### Dreaming

**Dreaming**:
Background consolidation of recent experience into core memory, modeled on Letta's dreaming.
_Avoid_: reflection,归纳, summarization, background job

**Consolidation**:
What a dream run does: read the transcript and activity evidence, decide what is durable, and
rewrite notes and the memory index accordingly, promoting or demoting facts between layers.
_Avoid_: extraction, distillation, index

**Dream run**:
One execution of dreaming, from trigger to applied changes or discard.
_Avoid_: cycle, pass, job

**Staging copy**:
The private copy of live memory a dream run edits alone, materialized from a pre-run snapshot.
Evidence that named live memory is rewritten to point at it, and a run's changes reach live memory
only through the host's compare-and-swap apply.
_Avoid_: worktree, branch, sandbox

**Discard**:
The host's decision to throw a run's staging copy away instead of applying it, recorded as a
discarded run with a reason code. A discard declines the candidate edit; by itself it never
deletes or rewrites live memory — a run that leaked edits into live memory is undone by a
restore, which keeps the leaked tree as a snapshot.
_Avoid_: rollback, revert, delete

**Nightly trigger**:
The once-per-local-date moment named by `DREAMING_AT` in the memory timezone. A process that
starts after that moment catches up the same date once; the date is claimed when it fires.
_Avoid_: schedule, cron, interval

**Promotion**:
Moving a fact up a layer — from the transcript into a note, or from a note into the index's core
facts — because it recurs or the owner says it must always be known.
_Avoid_: elevation, pinning

**Demotion**:
Moving a fact down a layer, or deleting it, when newer evidence contradicts it. A contradicted
core fact returns to a note (corrected) or disappears; it never stays in the index.
_Avoid_: rollback, downgrade, correction (correction is the content; demotion is the move)

**Dry run**:
A dream run that computes changes and passes the layout check without applying them.
_Avoid_: shadow mode, rehearsal

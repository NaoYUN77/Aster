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
One completed request and reply between the owner and the agent. The unit of the dreaming
counter.
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
The small, durable set of notes that is in the prompt on every turn and that the owner and the
agent maintain explicitly.
_Avoid_: long-term memory, profile, context

**Daily archive**:
The append-only, searchable record of what happened, grouped by day and linked to its sources.
_Avoid_: transcript, history, log

**Recall**:
Finding something in the daily archive with search. A retrieval act, not a store.
_Avoid_: retrieval, lookup, RAG

**Working state**:
The host-derived, session-scoped summary of standing goals and open work that is injected for
the current context cycle. Maintained by the host, never by dreaming.
_Avoid_: scratchpad, short-term memory, core memory

### Dreaming

**Dreaming**:
Background consolidation of recent experience into core memory, modeled on Letta's dreaming.
_Avoid_: reflection,归纳, summarization, background job

**Consolidation**:
What a dream run does: read recent turns and the daily archive, decide what is durable, and update
core memory.
_Avoid_: extraction, distillation, index

**Dream run**:
One execution of dreaming, from trigger to applied changes or discard.
_Avoid_: cycle, pass, job

**Review pass**:
A second background check of a dream run's proposed changes against the transcript before they are
applied.
_Avoid_: validation, approval, audit

**Dry run**:
A dream run that computes and reviews changes without applying them.
_Avoid_: shadow mode, rehearsal

# Memory is a wiki with three layers, and the dream pass owns all of it

Earlier dreaming treated `MEMORY.md` as the whole of core memory and put a second model pass
("review") in front of every application. That put the responsibility for what memory says in the
wrong place: the dream pass could only propose, the reviewer could only veto, and neither could
rewrite structure. We replaced both with one layered wiki.

The layers are the transcript and activity evidence (what actually happened), notes (dense,
abstracted facts per topic, read on demand), and `MEMORY.md` (injected every turn: a short
`## Core` list and a `## Index` of one line per note). Notes are the middle layer; the dream pass
decides how many exist, what each covers and how each is written. Facts are promoted from
evidence to a note, and from a note into `## Core` when they recur or the owner insists. When
evidence contradicts a core fact, the dream pass demotes it into a note (corrected) or deletes
it. An explicit owner correction beats anything stored.

No review agent. Once the dream pass may edit notes, a pass that only reads a diff has nothing
left to decide; a veto would just delay a correction the next run would make anyway. What remains
is a structural check the host runs before applying: `MEMORY.md` exists, every note is linked
from `## Index`, every link resolves inside the wiki. That is cheap, deterministic, and it can
fail closed without judging facts. Content quality is the model's job; structure is the host's.

Considered and rejected: keeping the review pass for safety (it would gate exactly the
corrections the design now asks for); a fixed note count or a token budget per note (it encodes
today's idea of what memory looks like and stops the model from merging or splitting topics); a
large injected `MEMORY.md` (it would duplicate the notes and crowd out the prompt).

The layout check makes the index a hard invariant: a note no index links to is unreachable, so it
is not memory. The blast radius is bounded by the worktree and fast-forward apply from ADR-0001,
so a bad run costs one discard, never a damaged live tree.

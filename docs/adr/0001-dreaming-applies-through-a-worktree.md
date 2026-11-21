# Dreaming applies through an isolated worktree

Dreaming edits core memory while the owner may be editing the same files. We decided a dream run
writes in its own git worktree. At apply time the host commits the worktree (actor `dreaming`),
commits the live tree if it is dirty, rebases the dream commit onto the live HEAD when live
advanced in the meantime, and only then applies with `git merge --ff-only`. A rebase conflict,
timeout or failed layout check discards the worktree and branch; the live tree is never touched and a
forced merge is never used. Writing the live directory under a lock was simpler but would stall the
owner and leave no reviewable diff; report-only avoided the risk but did not deliver the automatic
consolidation the product wants. The worktree keeps the live tree untouched until a checked diff
is ready, and `git log` remains the undo path.

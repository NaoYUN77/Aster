# Dreaming applies through an isolated worktree

Dreaming edits core memory while the owner may be editing the same files. We decided a dream run
writes in its own git worktree, the host commits both sides, and the run applies with
`git merge --ff-only`; a conflict, timeout or review rejection discards the worktree. Writing the
live directory under a lock was simpler but would stall the owner and leave no reviewable diff;
report-only avoided the risk but did not deliver the automatic consolidation the product wants.
The worktree keeps the live tree untouched until a reviewed diff is ready, and `git log` remains
the undo path.

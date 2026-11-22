# Dreaming applies through a staging copy, without git

Supersedes [0001](0001-dreaming-applies-through-a-worktree.md).

Dreaming edits core memory while the owner may be editing the same files. ADR-0001 isolated a
dream run in a git worktree and applied with rebase plus a fast-forward merge. That design
failed in two ways, both observed on the isolated test stack:

1. **Discard did not quarantine.** The dream prompt's evidence carried live absolute paths (the
   owner's own message and the activity digest quoted them), and the agent's tools resolve
   absolute paths without confinement — so a run could edit live memory directly. Discarding the
   worktree and branch deleted only the candidate edit; the stray live writes stayed, and the next
   turn-boundary commit captured them as if the owner had written them. Git could not have deleted
   them anyway: uncommitted working-tree changes belong to no branch, so no git command reverts
   them.
2. **Git was the wrong shape for the job.** Turn-boundary commits laundered whatever they found,
   `git log` as the documented undo path required shell access to the data directory, and the
   rebase/merge machinery existed only to answer one question — did live change where the dream
   also changed?

We decided the host owns file management and dreaming only proposes edits:

- A run works in a **staging copy** under the data directory, materialized from a pre-run
  snapshot. The evidence's live paths are rewritten to the copy before the model sees them.
- The host applies with a **per-file compare-and-swap**: a file applies only if live still matches
  the tree the run started from; any live drift on a changed file discards the whole run
  (`conflict`). No merging, ever.
- If live drifted *outside* the run's changed files with no host snapshot in between, the run
  leaked into live memory: live is restored from the pre-run snapshot (`live-modified`), and the
  leaked tree survives as a `pre-restore` snapshot.
- **Snapshots** — full-directory captures under the memory directory's `.aster/versions/`, taken
  at turn boundaries, before applies and before restores, retaining the newest 50 — replace
  commits as the undo unit. The memory CLI (`history`, `restore <id>`) is the rollback path; a
  restore is itself undoable.

Writing the live directory under a lock was simpler but would stall the owner; keeping the
worktree and adding path confinement would have preserved git's second failure mode while
patching the first. The staging copy makes the leak impossible to cause silently (evidence never
names live paths), possible to detect (drift with no host activity), and recoverable by ordinary
file operations. An existing `.git/` directory is left untouched; nothing reads it.

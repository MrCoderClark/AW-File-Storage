# Removing the Claude co-author from git history

Ran 2026-09-10. Records the procedure, the verification, and the traps — because
the obvious verification command gives a **false negative** and the obvious
"backup branch" is not a backup.

## Why a history rewrite was needed

GitHub's **Contributors** sidebar is derived from commit authorship on the
**default branch**. There is no setting to remove a contributor. Claude appeared
because 9 commits carried trailers written by Claude Code:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_...
```

The `author` of every commit was already Joe Clark — only the trailers had to go.
7 of the 9 were on `main`; the other 2 were pre-squash originals still sitting on
`phase-13-o365-sync` and `docs-specs-0009-0010`.

## Baseline (capture these first)

```powershell
git log --all --format="%an|%ae" | Sort-Object -Unique     # confirm author is only you
git log --all -i --grep="Co-Authored-By: Claude" --oneline # which commits
git rev-list --all --count                                 # 151 - the number to match after
git branch | Measure-Object -Line                          # 53 local branches
```

The commit count is the safety check: a message-only rewrite must not change it.

## The strip script

`d:/Code/strip-claude.sed`, kept **outside** the repo so the rewrite cannot touch it:

```sed
/[Cc]o-[Aa]uthored-[Bb]y:.*[Cc]laude/d
/[Cc]laude-[Ss]ession:/d
```

Bracket classes instead of sed's `I` flag, for portability. One of the trailers
had a stray leading space, which `/d` handles since the pattern is unanchored.

## Preconditions

```powershell
git branch --show-current      # main
git status --porcelain         # must be empty; filter-branch refuses on unstaged changes
git fetch origin
git rev-parse main origin/main # last safe pull point
```

## Backup, then rewrite

```powershell
git bundle create d:/Code/aw-backup-before-rewrite.bundle --all
$env:FILTER_BRANCH_SQUELCH_WARNING=1
git filter-branch --msg-filter "sed -f d:/Code/strip-claude.sed" --tag-name-filter cat -- --all
```

~91 seconds for 151 commits across 53 branches.

## Verify — use `--branches --remotes`, NOT `--all`

```powershell
git rev-list --branches --remotes --count                                  # 151
git log --branches --remotes -i --grep="Co-Authored-By: Claude" --oneline  # empty
git log --branches --remotes -i --grep="Claude-Session" --oneline          # empty
git rev-parse main                                                         # changed
```

**`--all` lies here.** It includes `refs/original/*`, the snapshot filter-branch
saves, so straight after the rewrite `git rev-list --all --count` read **300**
(151 old + 149 new) and `git log --all --grep` still listed all 9 trailer
commits. Both were the backup refs, not a failed rewrite. The tell: those
commits had lost their branch decorations.

## Push, then clean up

```powershell
git push --force --all origin
git fetch origin --prune
git for-each-ref --format="%(refname)" refs/original | ForEach-Object { git update-ref -d $_ }
git reflog expire --expire=now --all
git gc --prune=now
```

After the gc, `git rev-list --all --count` finally reads **151**.

## Prevent recurrence

Without this the next AI-assisted commit re-adds the trailer and the whole
rewrite has to be repeated:

`.claude/settings.json`

```json
{ "includeCoAuthoredBy": false }
```

## Traps

- **`filter-branch` also rewrites `refs/remotes/origin/*`.** Your
  remote-tracking refs then describe the rewrite, not what GitHub actually has,
  so `git rev-parse main origin/main` is meaningless until after push + fetch.
- **A branch named `backup-before-removing-claude` was itself rewritten** (it is
  in the rewritten-refs list). Branches are not backups of a `--all` rewrite.
  Only the bundle and `refs/original` are.
- **`.gitignore` does not untrack an already-tracked file.**
- **`git branch -r --merged origin/main` only lists**, it deletes nothing.
- **"had recent pushes" banners** appear because the force-push touched every
  branch. They expire in ~24h, cap at 3, and must NOT be actioned — clicking
  through would open unwanted PRs.
- **The Contributors sidebar is a cached background job** and lags ~24h. Verify
  the underlying commit instead, e.g. `37d4b6c` became `7b364b4`.
- **Merged PRs keep their original commits** (#34, #36 here). Not history you
  control; only the default branch feeds the sidebar.
- **Public repo:** force-pushed-away commits stay reachable by old SHA for a long
  time. Irrelevant for a trailer; for a leaked secret, always rotate.

## Recovery

```powershell
git clone d:/Code/aw-backup-before-rewrite.bundle
```

Restores the complete pre-rewrite state, all refs. Delete the bundle once the
result has been confirmed for a few days.

## Left alone deliberately

Some older commit messages (e.g. `7b364b4`) contain leftover shell heredoc text
— a bare `EOF`, then `git push` / `gh pr create` lines — from how they were
originally authored. Pre-existing, cosmetic, not introduced by this rewrite
(the sed script only deletes matching lines). A `/^ *EOF *$/,$d` rule would
strip it if ever wanted.

## Result

151 commits intact, both trailers gone from every live ref, `main` `b6f31f8` →
`00b1236`, force-pushed to `origin`.

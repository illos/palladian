# Palladian: deep sleep

On 2026-09-26 the owner explicitly shelved the entire app-hosting-platform concept:

> please stash and shelf that whole first batch of work, with a comment that its in deep sleep for now

The current product focus is the original **Deltos: a fast, MCP-first notes app**. Palladian is in **deep sleep for now**, with no scheduled restart. This decision supersedes the ongoing platform-roadmap authorization and old implementation prompts. Do not continue its phases, deploy its unfinished work, or treat it as the required foundation for Deltos. Resume only on a new explicit owner request.

## Preserved work

- Accepted foundation: `57c4fe04831a5bea010b5fee14debc3af8214924`, retained on `chore/palladian-deep-sleep-2026-09-26`. P0 through P2 are independently accepted for the documented local-development scope.
- Exact unfinished tracked and untracked work: stash commit `fc52dff6db32b95de84d3f76214a5e6073086e93`, named `DEEP SLEEP 2026-09-26: Palladian app-hosting platform WIP; focus returns to fast MCP-first Deltos notes`.
- Annotated tag `archive/palladian-wip-2026-09-26` anchors that stash commit independently of its changing stash-list position. Its untracked-file parent preserves the new P3 source, review, fixtures, uploader, and tests. The stash also preserves existing owner edits and generated-type changes without adding generated output to the documentation commit.
- P3 private files/search was incomplete and unaccepted. P4 usable Notes/Recipes and P5–P9 were not completed. This shelf is preservation, not implementation acceptance.
- Ignored environment files, local databases, dependencies, and build artifacts remain on disk and are not included in the Git shelf. Existing hosted-development resources and the separate hosted checkout were not changed. Hosting evidence in the stash records a published auth shell and passing smoke tests; hosted real-expiry evidence remained pending.

**GitHub backup completed on 2026-09-26:** [illos/palladian](https://github.com/illos/palladian) is configured as `origin`. The owner identified the repository after the initial local shelf; authentication uses the broker-injected GitHub credential through the GitHub CLI helper. Main, `chore/palladian-deep-sleep-2026-09-26`, and annotated tag `archive/palladian-wip-2026-09-26` were pushed and their remote object IDs verified. The tag preserves the complete stash graph, including its untracked-file parent. Do not delete the archive branch or tag as ordinary merged-branch housekeeping.

## Recover only when explicitly requested

In a new clone, fetch the archive branch and tag and recreate the local baseline branch first:

```sh
git fetch origin refs/heads/chore/palladian-deep-sleep-2026-09-26:refs/remotes/origin/chore/palladian-deep-sleep-2026-09-26 refs/tags/archive/palladian-wip-2026-09-26:refs/tags/archive/palladian-wip-2026-09-26
git branch chore/palladian-deep-sleep-2026-09-26 origin/chore/palladian-deep-sleep-2026-09-26
```

Skip that branch-creation command if the local archive branch already exists. Use a fresh worktree at the preserved baseline, then apply the exact stash there. Applying retains the original stash and archive tag:

```sh
git worktree add .worktrees/palladian-resume -b feat/palladian-resume chore/palladian-deep-sleep-2026-09-26
git -C .worktrees/palladian-resume stash apply fc52dff6db32b95de84d3f76214a5e6073086e93
```

Read this sleep decision before using the restored historical instructions. Reassess the unfinished work and deployment targets before running it. Do not apply the stash directly over the sleep notices on main. Future backup or repository moves must preserve both the baseline branch and the annotated stash tag; a normal push of main alone does not preserve the unfinished work.

## Shelving verification

Verified the stash contains all 28 previously modified/untracked files, the archive branch matches the accepted baseline, and the annotated tag resolves to the exact stash commit. The shelf changes only documentation and the worktree ignore rule; application checks were not rerun, and no new runtime, service, browser, or physical-device acceptance is claimed.

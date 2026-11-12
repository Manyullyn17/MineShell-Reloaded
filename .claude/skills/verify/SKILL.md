---
name: verify
description: Adversarial check of a finished feature or fix batch before calling it done. A fresh agent that sees only the diff and the task tries to break the change (races, reloads, long names, narrow windows, old Minecraft versions) using the repo's own tools, and reports only failures it reproduced. Use at the end of a feature or batch of fixes (once, not per commit), before telling the user it works.
---

# /verify — try to break it before saying it works

Run this once per feature or fix batch, after the last commit and before the closing message,
not after each commit. Arguments (optional): a git range (`main..HEAD`, `abc123..`) and/or a
sentence describing the task. Without arguments, work them out.

## 1. Gather what the reviewer gets

- **Range**: the commits that make up this feature. Usually `@{upstream}..HEAD` on the current
  branch, or the commits since the user asked for it (`git log --oneline` to find the base).
  Include uncommitted changes if there are any. Check `git branch --show-current` first.
- **Task**: one or two sentences on what the change is meant to do, in the user's terms. Not
  how it works or why it is correct: the reviewer should form its own view from the diff.
- **Surfaces**: which pages, endpoints, operations or tools the diff touches. List these as
  facts ("Settings > Java tab", "export endpoint", `rcon.ts`), without saying what to suspect.

## 2. Start the reviewer

Start one `general-purpose` agent (foreground) with the prompt below, filling in the
placeholders. Do not add your own reasoning, test results or "this should be fine" notes:
the point is a reviewer that doesn't share them.

```
You are reviewing a change to MineShell (this repo; read CLAUDE.md, and the docs/notes/ file
for each area the diff touches). Your job is to BREAK it, not to approve it.

Task the change is meant to do: <task>
Commits: <range>   (read them with: git diff <range>; git log <range>)
Surfaces touched: <surfaces>

Look for, as they apply to this diff:
- concurrency: two requests at once, double-clicks, a reload or poll landing mid-operation,
  a timer that runs code it started with, the same thing in two tabs
- Svelte state: $effects re-running on every data reload (servers starting reload every 3 s),
  form reset after enhance, one-way bindings missing post-save updates, buttons that
  re-enable or stay disabled
- inputs and data at the edges: empty/missing, huge, long unbroken names (servers up to 80
  characters, mods, paths, players), 1.7.10 / 1.12 / modern formats, each loader, a server
  that is stopped / starting / running / crashed
- layout: 390 px width, a short window, long names spilling out of their box
- failure paths: what the user sees when the network, systemd, Java or a file read fails;
  whether a half-done operation leaves something the next run trips on
- access: a restricted account doing it (src/lib/server/access/policy.ts)

Run things rather than only reading code:
- npm run check; npm test (both must pass; report the output if not)
- a throwaway dev server, never the user's: 
    MINESHELL_UNIT_PREFIX=msverify tests/tools/devserver.sh start 5196 /tmp/ms-verify
  and drive it with tests/tools/ (pageshot.mjs with --overflow/--spill/--errors/--click/--eval,
  page-sweep.mjs, seed-instance.mjs for a server of some shape, act.mjs, rcon.mjs,
  server-state.mjs, scenarios.sh; see tests/README.md "Manual tools"). The screenshot world
  (`npm run screenshots -- --serve`, port 5198) has a fake running server and long names.
  Never run `npm run screenshots` without --serve/--long or a shot name: it rewrites the
  README pictures.
- reproduction scripts and pictures go in /tmp/ms-verify-work/, not the repo.

Rules: do not edit, commit or stash anything in the repo. Do not touch ~/mineshell-data,
~/.local/share/mineshell, the `mineshell` or `minecraft@` units, port 3000 or 5199, or
~/mineshell-old. Do not start VMs. No `pkill -f`. When done:
  MINESHELL_UNIT_PREFIX=msverify tests/tools/devserver.sh clean 5196 /tmp/ms-verify
and stop anything else you started.

Report, and nothing else:
1. CONFIRMED failures, most serious first: what breaks, exact steps or script to reproduce,
   what you saw vs. what the task implies, file:line where it goes wrong if found.
2. Suspicions you could NOT reproduce, each with why you suspect it and what you tried
   (keep these short and separate; they are not findings).
3. What you exercised and how (command or tool per item), so the gaps are visible.
Do not report style, naming or refactoring opinions.
```

## 3. Act on the report

- Each confirmed failure: write a test that fails without the fix (CLAUDE.md: a bug fix gets
  a test), fix it, commit as usual (`fix:` on the right branch).
- Suspicions: check the ones that are cheap to check; mention the rest to the user, don't
  silently drop them.
- If there were fixes, run the reviewer again on just the fix commits plus the original task.
  At most 2 extra rounds; if it still finds things after that, stop and tell the user.

## 4. Closing message to the user

Give a short table: change, how it was verified (unit test / throwaway server / browser
check / VM / reviewer reproduction / not verified), remaining risk. "It compiles" and "the
code looks right" count as not verified. Say what the reviewer caught and what was fixed, and
name plainly anything that needs the user (prod, a real client, sudo, a VM run).

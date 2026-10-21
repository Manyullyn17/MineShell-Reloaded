# Status and open threads

Where things stood, what the user has yet to try and the state of their test servers, moved out
of CLAUDE.md (2026-10-20). Open work itself is `docs/ROADMAP.md`.

## Where it stands (2026-10-21, 0.30.2)

Heading for 1.0 (ROADMAP, "Current direction" and "Road to 1.0"). Agreed 2026-10-21:
- World backups to another place (a folder on this machine first, no cloud, extensible) are
  the last feature before 1.0; then a feature freeze and a release candidate.
- The status page moves to after 1.0, with the item icon leftovers and per-world game
  settings. Plugin servers stay 2.0; GT New Horizons has no slot yet.
- Minor dependency updates before the freeze; TypeScript 7 waits until after 1.0.
- Long running is covered: the installed MineShell has run a server with scheduled restarts
  and snapshots since it was installed.
- arm64 and musl stay untested (no such hardware; home servers are nearly always x64). Only
  Java downloads and playit.gg's agent depend on them; a Java added by path works anywhere.

Next after the docs update: route tests. Form actions and endpoints are tested with
`tests/helpers/routes.ts` (tests/README), but not all of them; finding which have none and
which matter is the first step. ("Route/form-action tests" used to be listed as shelved
here; that was before the route helper.)

## Left for the user

- Notifications to a Discord channel (ntfy.sh is tried: crash with cause, memory kill
  folded, stuck after 10 min, 2026-10-15).
- Importing the `.mrpack` and CurseForge client exports (`~/Downloads/mineshell-export-test`;
  the Prism export is done).
- A server export and import with a CurseForge pack and with a world of gigabytes.

## Real-loader passes

2026-10-15 (throwaway setup, `tests/tools/`): migration Fabric 1.20.1 -> 1.21.1, Quilt
0.26.4 -> 0.30.1, pack update Cobblemon 1.8.1 -> 1.8.2 via the update notice, Forge 1.12.2
missing-entries question answered, Forge 2859 -> 2864: all booted. Found: Quilt's unordered
loader list, Forge's question read from one millisecond (both fixed). Installed on a phone
by the user (2026-10-16): works. A repeatable checklist for the next pass is on the road to
1.0.

## The user's test servers

MeatballCraft (user's main test pack): runs on Cleanroom 0.5.x only (0.5.17 starts fine after
"Reinstall pack files" on `meatballcraft-cleanroom`). `meatballcraft-dimensional-ascension`
still predates the overrides fix and needs the same (then delete the stray
`mods/overrides.zip`); the Cell Terminal crash was the missing pack configs.

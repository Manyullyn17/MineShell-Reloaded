# Status and open threads

Where things stood, what the user has yet to try and the state of their test servers, moved out
of CLAUDE.md (2026-10-20). Open work itself is `docs/ROADMAP.md`.

The bugs reported 2026-10-07/08 (console freeze, RCON filter, Files upload, ATM10 Curios
lists) and drag-and-drop uploads are done (ROADMAP-ARCHIVE, "Reported bugs, October 2026").

Agreed next steps (all written up in `docs/ROADMAP.md`), in order:
1. Built 2026-10-08: **CurseForge client-only detection** (`curseforgeClientOnly` in
   clientonly.ts): own file tagged, or the newest file for that mc+loader tagged. Checked on
   the mirror: Mouse Tweaks 1.12.2 tags only its newest file; JEI, AE2, Iron Chests,
   Waystones 1.12.2 tag none.
2. Agreed next: the "Later" items. Saved for later: client-only detection (above), mod-update leftovers, Discord
   notifications. General world backups remain a maybe. Installing from CurseForge server
   packs was rejected (ROADMAP, "Considered and rejected").
3. Brainstorm of October 2026 (ROADMAP-ARCHIVE, "Brainstorm, October 2026"): the agreed items are
   built (Spark profiler, Chunky, console, bans, disk usage, Java defaults). Left there: the
   "Later" / "Maybe" / undecided lists; Spark as a TPS source is not possible over RCON.


Built 2026-10-08: memory advice, scheduled snapshots, chat in the console, log search,
mclo.gs. Later that day: streamed loading for the slow tabs, pack updates from an uploaded
file, Minecraft version/loader migration. Plugin servers: 2.0, the first major update after 1.0 (all basic functionality there
and stable), maybe after a few minor additions (ROADMAP, user's call 2026-10-16); not before.
Next (user's call, 2026-10-08): item icons in the player editor. A world map is wanted but
undecided (ROADMAP-ARCHIVE, "A map of the world": BlueMap CLI recommended). Next pass (user's call): GT New Horizons as its own install option, and playit.gg
(the user is making an account first).

Shelved: route/form-action tests; booting real loaders as a repeatable test run.

Player data backups never overwrite each other (fixed 2026-10-14; the "restores a backup"
test used to fail when a save's and a restore's backup fell in the same millisecond).

Real-loader pass, 2026-10-15 (throwaway setup, `tests/tools/`): migration Fabric 1.20.1 ->
1.21.1, Quilt 0.26.4 -> 0.30.1, pack update Cobblemon 1.8.1 -> 1.8.2 via the update notice,
Forge 1.12.2 missing-entries question answered, Forge 2859 -> 2864: all booted. Found: Quilt's
unordered loader list, Forge's question read from one millisecond (both fixed). Notifications
from real runs (crash with cause, memory kill folded, stuck after 10 min) reached ntfy.sh.
Left for the user: a Discord channel, importing the .mrpack and CurseForge exports
(~/Downloads/mineshell-export-test; the Prism export is done). Installed on a phone by
the user (2026-10-16): works.

Beta order (user's call, 2026-10-16): ROADMAP, "Current direction".

Java downloads on arm64 and musl (Alpine) stay untested (user's call, 2026-10-18: no such
hardware here) - the code picks those builds, but every machine here is x64 glibc.

MeatballCraft (user's main test pack): runs on Cleanroom 0.5.x only (0.5.17 starts fine after
"Reinstall pack files" on `meatballcraft-cleanroom`). `meatballcraft-dimensional-ascension`
still predates the overrides fix and needs the same (then delete the stray
`mods/overrides.zip`); the Cell Terminal crash was the missing pack configs.

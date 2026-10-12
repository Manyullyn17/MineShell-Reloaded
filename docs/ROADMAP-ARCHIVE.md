# Roadmap archive

Historical planning notes retained for context. Current plans and status are in
[ROADMAP.md](ROADMAP.md). Some archived proposals were undecided or deferred at the time;
check the current roadmap before treating one as active.

## Dependency order

Some of these unlock others. Rough ordering:

```
mod updates ──────────► duplicate detection across platforms
     │
     └────────────────► hash-based mod cache

notifications ────────► needs no new infrastructure, the event bus already exists

remote access ────────► depends on the auth model, which is now settled
```

Mod updates were the biggest unlock and are built, so both arrows on the left are open now.
Everything else is largely independent and can be done in any order.

---

## Near term

Agreed order: the rest of this list roughly as written. (World snapshots, world tools,
server copies, Java downloads, mod updating, the smaller operational features -
countdown stops, TPS, scheduled commands, resource limits, stuck-start warning, log
history, server icon - the modpack install refinements (mod list with client-only
choices before installing, "Install & start") and the player data editor are built.)

Not covered by the install form's mod list: uploaded packs (installed straight from the
upload; the client-only check still runs afterwards), and client-only mods only the jar
declares (known once downloaded; the same check catches them).

### Mod updating: what is left

Built: "Update mods" (check, review, update; world snapshot per the policy) and switching
one mod to any compatible version, older ones included (world snapshot opt-in), journalled
as `mod-update`. On a modpack server both are greyed out until a toggle is turned on.
Not built from the original design:

- Downgrade/disabled-mod options: built (2026-10-08): disabled mods start unticked in the
  update review; ticked, they are updated and stay disabled.
- Built (2026-10-08): a new version's (or a dependency's) `incompatible` declarations are
  warned about in the review and the task's status (Modrinth only: the mirror's dependency
  lists have no such type). A dependency only the old version required, which no other
  enabled jar requires (its own metadata), is offered to be disabled, ticked, in the same
  journalled change. Pack mods and locked ones are never offered.

---

## Brainstorm, October 2026

A list of ideas from a brainstorm, checked against the code on 2026-10-04. Where an idea was
already built, or already has an entry elsewhere in this file, that is noted, so it is not
re-proposed or built twice.

### Already built (listed in the brainstorm, nothing to do)

- **Scheduler upgrades**: scheduled restarts wait while players are online, for up to an
  hour per cycle (`scheduler.ts`), and warn in-game at 15/10/5/1 minutes
  (`restartWarnMinutes`). Countdown stops/restarts: `countdown.ts`.
- **Mod diff before an update**: the pack change preview (`PackChangePanel`) lists every
  pack mod and data pack as `+`/`~`/`−`. The "Update mods" review shows `current → target`
  for each mod.
- **Mod list view**: the installed list on the Mods tab links each mod to its project page
  and flags client-only ones. Loader is per server. The crash analyzer reads the jars itself
  (`crashdiag.ts`) and does not need this list.
- **Start-time Java resolution**: `start()` runs `syncUnit()`, which resolves Java again and
  rewrites the unit's env file, so the unit cannot go stale (see "Default Java per major
  version" below for what is still missing).
- Also built: crash analyzer, auto-restart, CPU/RAM graphs, the whitelist/ops/bans lists,
  the `server.properties` editor, snapshot pinning, and a basic audit log (the `audit_log`
  table; Settings shows the newest 40 entries).

### Next up

- **Spark profiler flow**: built (`spark.ts`, the Spark profiler panel on the overview).
- **Spark as a TPS source**: not possible over RCON. Spark runs every command on a worker
  thread, so RCON has already returned when Spark answers, and `spark tps` replies only to
  the sender: the answer is dropped (vanilla clears the RCON buffer at the next command).
  Only broadcasts reach the console. The servers this would help are Fabric/Quilt/vanilla
  before 1.20.3 (no `tick query`). Ways left, none cheap: a stdin channel into the server
  (a FIFO as the unit's StandardInput, so commands run as the console), or a small
  companion mod. Not planned.

### Agreed

- **Chunky integration**: built (`chunky.ts`, World tab). Start a square or circle around a
  center in any dimension, live progress (ETA, rate), pause, continue, cancel, continue
  unfinished tasks, and pausing while players are online (MineShell's scheduler, English
  Chunky only). Time windows: scheduled commands `chunky continue` / `chunky pause`.
  Chunky has no 1.12 build.
- **Console enhancements**: built. Level filters, "only players joining and leaving",
  search with highlighted matches, stack traces folded under their error, ANSI colour codes
  stripped (modern Forge), the server's lines about RCON connections hidden by default
  (MineShell's own polling floods them), command history kept per server in the browser,
  and saved commands per server (`macros.ts`, copied with a server copy). Autocomplete was
  left out: RCON cannot ask Brigadier for completions, and a fixed list would not know mod
  commands. The Logs tab's search is "Log search" under Agreed for later (built).
- **Ban UI, the rest**: built. Ban reasons, IP bans (`banned-ips.json`; by address while
  stopped, by online player while running), Ban / Ban IP next to Kick, operator levels and
  player-limit bypass (picked and changed only while stopped: vanilla has no command for
  them and keeps ops.json in memory).
- **Disk usage breakdown**: built (`diskusage.ts`, Files tab > Disk usage, or the overview's
  "Disk used"). The world per dimension (vanilla, 1.12 `DIM<n>` and named mod folders,
  1.16+ `dimensions/<ns>/<name>`, Bukkit siblings), snapshots and MineShell backups,
  `old-configs/` per version, logs, mods, loader, the rest; suggestions point to where to
  act, and archived logs/crash reports older than 30 days can be deleted from there.
- **Default Java per major version**: built. A pinned path wins, then the runtime set as
  default for the major (Settings, "Servers use" column), then the newest build of it, with
  the path between equal builds. The overview and the server's Java picker say which applied.
  Resolution at start time already existed (`start()` rewrites the env file).

### Later

- **Three-way config diffs on pack update**: built (2026-10-08, `configmerge.ts`). Decided:
  clean merges apply on their own; overlapping changes take the pack's lines and are listed
  for review (Settings > Modpack: compare, use mine / the pack's); the user's own files in
  pack folders are carried over; a server without saved originals reads its installed
  version once.
- **World tools**: dimension reset is built (World tab; `dimensions.ts`, `resetDimension`).
  The overworld means its terrain (region, entities, poi); level.dat, player data and the
  world's data stay. Chunk pruning is built too (`chunkprune.ts`, World tab): chunks whose
  InhabitedTime is under a threshold go from region/, entities/ and poi/, files rewritten
  compactly; optionally keeping a radius around spawn; counted first, run as a world change
  into a partial snapshot. LZ4-compressed chunks (1.20.5+ option) cannot be read and stay.
- **Granular snapshot restore**: built for one dimension (`restoreDimension`); a region of
  one is not. A dimension reset keeps a partial snapshot (`partial: true`), whose restore
  puts back only those folders.
- **Scheduler hook**: run a script after a snapshot.

### Maybe someday

- **Notifications (Discord/webhook)**: see "Notifications" under Later.
- **Client pack export**: built (October 2026; `packexport.ts`, the server's Export page):
  Modrinth, CurseForge and Prism Launcher formats. Different from "Instance export and
  import" below, which moves a server between machines. Not done: a pack icon (none of the
  formats has a place both launchers read), CurseForge fingerprint lookups to link
  manually added jars in a CurseForge pack (needs the official API key), packwiz.
- **Player stats** from `<world>/stats/<uuid>.json`.
- Multi-user roles: out of scope.

### Undecided

- **Read-only status page**, mainly worth it together with a **join page** (address,
  version, pack download).

### Suggested, not yet confirmed or rejected

- **RAM guard on start**: refuse or warn when the heap plus other running servers exceeds
  free memory. Nothing reads `/proc/meminfo` today.
- **Port management**: same as "Multi-instance port management" under Later. Start already
  refuses when a port is taken by something else.
- **Sleep when empty**: `pause-when-empty-seconds` on vanilla 1.21.2+. For older and modded
  versions, it is unknown which loaders honour it.
- **Mod bisect assistant**: built (2026-10-07, `bisect.ts`, Mods tab): see ARCHITECTURE,
  "The mod bisect assistant". The note: disable half, start, narrow down. It could build on the crash
  analyzer and the journalled mod toggles.
- **Update availability checks**: mods have one (`modupdates.ts`). Missing: a newer pack
  version, loader build, or Java update shown on the overview.
- **Log rotation and retention**: nothing deletes old `logs/` or `crash-reports/` on its
  own; the disk usage page offers to delete archived logs and crash reports older than 30
  days.
- **Server bundle export/import**: the same as "Instance export and import" under Later.

### Agreed for later (2026-10-07)

Suggested after the client pack export and reboot handling; all wanted.

- **Start-time history**: built (2026-10-07, `history.ts`): the overview's Uptime shows the
  last start against the usual, the Logs run list each run's. The note: how long each start took to reach `Done (`, per run, with the
  trend on the overview ("4 m 10 s, usually 2 m 30 s"), so a pack update or a new mod that
  slows startup shows. The journal has both timestamps (the unit's start, the `Done (`
  line); reading them per invocation like `runFinishedStarting` avoids walking old runs.
  Pairs well with player history, which also wants console lines kept over time.
- **Crash history**: built (2026-10-07, `history.ts`): crashed runs marked by the overview's
  rule, each put through the crash analyzer once; Recent crashes on the overview (with the
  cause that repeats), causes in the Logs run list. The note: the overview shows only the last crash (`lastcrash.ts`). Keep each
  crash with its diagnosis (culprit, cause line) and date, and list them, so a pattern
  shows ("every few days, always the same mod"). A small table, filled when the monitor
  sees a crash, rather than re-diagnosing old runs from the journal each time.
- **Memory advice**: built (2026-10-08, `heap.ts`, `memoryadvice.ts`): the heap read over the
  JVM's attach socket, since the cgroup's memory cannot tell. An `OutOfMemoryError` in a run, or memory sitting near the heap limit
  (the overview's samples), suggests more heap; a heap never half used suggests less, judged
  only from hours with players online (2026-10-10, the user: an idle server's 2 GB says
  nothing when players take it to 8).
  Shown on the overview and next to Java & memory in Settings. Advice only, never changes
  the setting by itself. Related: the RAM guard and the resource cap above.
- **Scheduled snapshots**: built (2026-10-08, `snapshotschedule.ts`), both modes, with the
  file-quiet wait below for old Forge. A world snapshot on a schedule ("nightly at 4:00"), kept by the
  existing retention policy. The narrow case of "World backups" above, still local only.
  Snapshots today are only taken with the server stopped. Two modes, per schedule:
  - *While running* (default): the consistency dance that section describes (`save-off`,
    `save-all flush`, copy, `save-on` in a finally), as the running-world download already
    does. Players keep playing; the world just is not autosaved during the copy. Things to
    check: mods that write their own files outside the world's save cycle, and whether
    `save-all flush` is honoured on old Forge (1.12 has no `flush` argument and saves
    asynchronously, so it would need waiting for the "Saved the game" line).
  - *Stop, snapshot, start*: for when a live copy is not trusted (or the checks above fail
    for a pack). One scheduled action does it all: countdown warnings like a scheduled
    restart, stop, take the snapshot, start again as soon as it finishes - only if the
    server was running when the schedule fired. No separate scheduled start with a guessed
    gap, which either cuts the copy short or keeps the server down longer than needed.
  A stopped server is snapshotted as it is either way. Shown as a task in the notification
  center; a failed copy still restarts the server (and says the snapshot failed).
- **Chat in the console**: built (2026-10-08): a Chat chip and a chat send mode. A filter showing only player chat (`<name> message` lines and
  `[Server]` messages), and sending as the server with `say`. The console already sorts
  lines by kind (`consolelines.ts`), so it is a new kind plus a send mode.
- **Log search**: built (2026-10-08, `logsearch.ts`): one search over every run in the
  journal (`journalctl -g`, escaped, any case) and every log file, archives included; the
  open log lists its matching lines from all of it, not only the end shown. The Logs tab (past runs and log files) cannot search; only the live
  console can. Searching a run reads it from the journal by invocation; log files and
  gzipped archives are read from disk.

### Dropped

- Panel hardening (it is LAN-only; remote access stays the Tailscale route below), idle
  auto-stop (wake-on-connect needs too much machinery), a fuller audit log beyond the
  existing one, adopting an existing server.
- Full world backups: see "Deliberately not built" above.

---

## Reported bugs, October 2026 (fixed)

Reported 2026-10-07 and 08; all fixed 2026-10-08.

- **Built: console page froze on a starting ATM10 server.** Every line re-filtered and
  re-rendered the whole buffer; lines now go in every 50 ms as one batch.
- **Built: the "RCON connections" console filter did nothing** on NeoForge, whose lines carry
  a `[minecraft/GenericThread]` logger tag; the chip now also shows them with the level
  chips off.
- **Built: uploading in Files jumped back to the server's root folder.** SvelteKit 3 forms
  posting `?/x` dropped the page's query; every page now uses `#lib/shared/forms.ts`.
- **Built: ATM10's Curios lists in the player editor** (one Stacks and one Cosmetics list per
  slot type, 42 in all, all labelled alike): one closed Curios section, rows named by slot
  type, empty ones behind a checkbox.
- **Built: drag and drop in Files**, files and whole folders, into the folder being shown.
  Since 2026-10-08 on every upload (world zip, pack file, new-server pack, mod jars, icon),
  each onto its own section rather than the whole window (`lib/shared/dropzone.ts`).
- **Built 2026-10-10: Forge 1.12 waiting on "/fml confirm" at startup.** MeatballCraft
  (Cleanroom) stopped after a pack update over 17 missing blocks/items/sounds and nothing
  could answer: a unit has no console input and RCON is not up yet. Two ways were weighed:
  a notice that answers by starting once with `-Dfml.queryResult=confirm`, or giving units a
  stdin (FIFO socket unit). The user picked the notice; the snapshot before it is on by
  default and can be unticked, and it covers all three questions Forge 1.12 asks (missing
  registry entries, missing registries, backup level.dat). Stdin stays an option if console
  input before RCON is wanted for its own sake.


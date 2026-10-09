# Architecture

Notes on why MineShell is put together the way it is. Aimed at future-you, coming back to
this after six months away.

---

## Process model

Every Minecraft server is a systemd service. There is exactly one unit file — a template,
`minecraft@.service` (the prefix is `MINESHELL_UNIT_PREFIX`) — and each instance is an
instantiation of it: `minecraft@survival.service`, `minecraft@skyblock.service`, and so on.
The instance id is the slug, and it doubles as the systemd instance name and the directory
name, so there is never a mapping table to keep in sync.

The template lives in `unit-template.js`, plain JavaScript so that `npm run setup` (plain
Node, outside SvelteKit) writes exactly what the app writes. MineShell rewrites an installed
copy at startup when it was written by an older MineShell (`refreshTemplateUnit`), so
changes to it reach existing setups without reinstalling.

Per-instance differences live in an environment file at `<data>/units/<id>.env`:

```
MS_JAVA=/usr/lib/jvm/java-21-openjdk/bin/java
MS_JVM_ARGS=-Xms2048M -Xmx8192M -XX:+UseG1GC ...
MS_LAUNCH_ARGS=@user_jvm_args.txt @libraries/net/neoforged/.../unix_args.txt nogui
```

and `ExecStart` is:

```
ExecStart=/bin/sh -c 'exec "$MS_JAVA" $MS_JVM_ARGS $MS_LAUNCH_ARGS'
```

Three things about that line matter.

**`exec`.** Without it the shell stays as PID 1 of the service and Java becomes its child.
systemd would then be watching the shell, not the server, so a crashed Java process would
look like a healthy service and `Restart=on-failure` would never fire. This is the same
reason the original design's tmux wrapper had to go.

**`/bin/sh -c`.** JVM arguments need word splitting. systemd's own `ExecStart` does not
split variables, so `$MS_JVM_ARGS` would arrive as one enormous argument. A shell does the
splitting, then removes itself with `exec`.

**Quoting.** `"$MS_JAVA"` is quoted because a path may contain spaces; the argument
variables are deliberately unquoted because they must split.

### Drop-ins

`Restart=` cannot come from an environment file — systemd reads unit directives before the
environment file exists. So per-instance restart behaviour is written as a drop-in at
`<unit>.d/restart.conf` next to the template instead, and `writeRestartPolicy()` owns that
file. Memory and CPU caps are a second drop-in, `limits.conf` (`MemoryMax=`, `CPUQuota=`),
from `writeResourceLimits()`. The template itself says `Restart=on-failure`, so a server
with no drop-in yet still restarts after a crash.

### Stopping

A stop sends `save-all` and `stop` over RCON, then waits up to five minutes for the JVM to
exit (`awaitStop`) before falling back to `systemctl stop`, which sends SIGTERM;
Minecraft's shutdown hook saves on that too. The template counts exit code 143 (SIGTERM) as
success, because only a stop someone asked for sends it. Big packs can take minutes to
save, which is why the wait is long: the old fixed 20 seconds cut saves off and could stop
a server that had been started again in the meantime.

### User scope only

MineShell uses `systemctl --user`, which needs no root at all, and servers run as the
account MineShell runs as. The cost is that services stop when the account's last session
ends unless lingering is enabled — hence the `loginctl enable-linger` step in setup and the
check in `doctor`. Output is read with `journalctl --user-unit=<unit>`.

A system scope (system units, sudo rules for `systemctl` and `journalctl`) existed until
October 2026 and was removed: its servers ran as root, MineShell needed write access to
`/etc/systemd/system`, and it was never used. A separate account with lingering gives the
same isolation without root (`docs/DEPLOYMENT.md`).

---

## Two deviations from the original design notes

### SSE instead of WebSockets

The notes specified WebSockets for console output and resource stats. This uses
Server-Sent Events.

A WebSocket in SvelteKit needs a custom HTTP server to handle the upgrade, which means
`vite dev` and `adapter-node` production need separate wiring and behave differently. SSE
is served from an ordinary `+server.ts` returning a `ReadableStream` with
`Content-Type: text/event-stream`, identical in both.

The thing SSE gives up is client-to-server messaging, which does not matter here: console
input is a single small POST per command, not a stream. So the console is one SSE stream
down and ordinary POSTs up.

Practical details that bit during implementation and are worth not re-discovering:

- A payload containing newlines needs `data: ` on every line, or the event truncates.
- Idle connections get dropped by proxies, so a `: keepalive` comment goes out every 25s.
- `X-Accel-Buffering: no` stops nginx buffering the stream into uselessness.
- The stream's `cancel()` is where subscriptions get torn down; without it, closing a tab
  leaks a journal tail.

### Scheduled restarts are application logic

systemd timers would be the obvious home for "restart every six hours", and the original
notes considered them. They are not used, because the actual requirement is "restart every
six hours, but warn players at 15, 10, 5 and 1 minutes first, and if someone is online,
wait — up to an hour, then go anyway." That is a decision that needs to query the running
server, which a timer cannot do.

So `scheduler.ts` ticks every 30 seconds, computes the next run per instance, sends
warnings over RCON, and calls the same `restart()` path the button in the UI calls. One
control path, one set of bugs.

### Servers after a reboot are started by MineShell, not enabled in systemd

The template has `WantedBy=default.target`, so `systemctl --user enable` would bring a
server back at boot without MineShell. It is not used: systemd would start the server
before MineShell's recovery runs, so a power cut in the middle of a pack change would boot
a half-changed server; it would start with whatever env file was last written (a start
resolves Java and rewrites it); and every server would load at once. Instead `bootstart.ts`
runs at MineShell startup, after `recoverInterruptedOperations`. It compares the kernel's
boot id (`/proc/sys/kernel/random/boot_id`) with the one stored in `settings`
(`host.bootId`): only a new boot starts anything, so restarting MineShell never does. Then
it starts, one at a time in list order, every ready server without an unfinished operation
whose `boot_start` is `always`, or `if-running` with `wanted_running` set, through the
normal `start()`, waiting for `Done (` (or the unit stopping, or 3 minutes) before the
next, as a task in the notification center. `wanted_running` is set by start and restart
and cleared by stop and by a `stop` sent from the console; a crash leaves it. The first
run with no stored boot id only records which servers are running.

---

## Console

Two channels, one view.

**Output** is `journalctl -f` piped through the backend. One tail process per instance, not
per viewer: `journal.ts` keeps a ring buffer of the last 500 lines, fans out to every
subscriber, and tears the process down 60 seconds after the last one leaves. Opening five
tabs costs one `journalctl`.

**Input** is RCON, implemented directly on `node:net` in `rcon.ts` — the Source RCON
protocol is a length prefix, an id, a type and two null-terminated strings, which is less
code than a dependency. Commands go out the same way an operator typing in-game would, so
they work identically.

RCON answers are used for things like the online player list and kick confirmation. A
command typed into the console shows its answer in the view, marked `[rcon]`, but it is
never written to the journal, which stays a faithful log of the server.

The view itself (`lib/shared/consolelines.ts`) sorts lines by level, folds stack traces
under the error that logged them, strips the ANSI colours modern Forge prints, and hides
the server's own lines about RCON connections by default — MineShell's polling opens
several a minute. Chat lines (`<name> text`, `[Not Secure] <name> text`, `* name`,
`[Server]`/`[Rcon]` from `say`) are recognised only right after the line's
"[time] [thread/LEVEL]" prefix, so a message cannot fake one; the console's chat mode sends
with `say`, which players see as `[Rcon]`. Saved commands are kept per server in the database (`macros.ts`); command
history stays in the browser.

**Logs tab**: the run list (`listRuns`, systemd's start/stop lines found with `journalctl -g`)
and a run's text (`readRun`, its last 20000 lines) take journalctl 1-3 s each on a big pack.
Both are kept in memory with the cursor of the newest entry read; later reads take only what
came after it (`--after-cursor`), so only the first read after MineShell starts is slow. The
newest 8 runs' text is kept. Both are streamed to the page (Frontend), so it opens at once.

**Log search** (`logsearch.ts`) looks through every run the journal still holds
(`journalctl -g` with the text escaped and `--case-sensitive=false`, the newest 5000
matching lines, ~0.5 s for a big pack's journal) and every file in `logs/` and
`crash-reports/`, `.log.gz` unpacked (up to 64 MB each, 8 s for all files). The open log
lists its matching lines from all of it (`matchesIn`: one run by invocation, one file
whole), since the viewer shows only a long log's end. `journalctl -o json` gives a MESSAGE
with control characters (Forge's colour codes) as a byte array; `messageOf` decodes it.

**mclo.gs** (`mclogs.ts`), only when asked from the Logs tab: `POST /1/analyse` returns
problems with solutions and keeps nothing; `POST /1/log` shares the log publicly for 90 days
(mclo.gs masks IP addresses, home folders and tokens) and returns a delete token, kept in
`log_shares` per run or file; Delete calls `DELETE /1/log/<id>` with it. What is sent is the log
as the page shows it, colours stripped, its end cut to mclo.gs's limits (25,000 lines,
10 MiB).

---

## Data

SQLite through Drizzle, in WAL mode with foreign keys on and a busy timeout set.

Migrations are plain `.sql` files in `migrations/`, inlined at build time by
`import.meta.glob('/migrations/*.sql', { query: '?raw' })` and applied by a small runner
that records what it has done in a `_migrations` table. This means the production bundle
has no migration tooling in it and no filesystem dependency on the source tree —
`drizzle-kit` is a development convenience for authoring, never a runtime dependency.
`vite build` loads the server modules to analyse the routes; while it does (`building` from
`$app/env`) the database is in memory and no data directory is created, so a build never
touches the data `.env` points at (CI checks it).

The release archive (`scripts/package.sh`) is that bundle plus its runtime `node_modules`
(better-sqlite3 carries prebuilt binaries for every platform, so it needs no compiler and
no npm), `setup.mjs`/`doctor.mjs` and `unit-template.js` for them. `scripts/install.sh`
unpacks it into `releases/<version>/` and swaps a `current` link, so an update is one
rename and the running process keeps its open files; DEPLOYMENT.md has the rest.

Updating itself (`selfupdate.ts`, Settings > Updates): the installer writes
`MINESHELL_INSTALL_HOME/CONFIG/SERVICE` into the service's environment, and only with those
does MineShell offer to update (a source checkout updates with git). The check reads
GitHub's `releases/latest` (never drafts or pre-releases) every 12 hours, keeping the answer
in `settings` (`update.check`). The update downloads the archive, checks it against the
published SHA-256, takes `install.sh` out of that archive and runs it with `systemd-run
--user` as a transient unit (`<service>-update-<ms>`): the installer restarts MineShell,
which kills its own children. `update.run` records it before it starts; the restarted
MineShell settles it as done when it runs the new version, and the running one as failed
(with the unit's journal) once that unit has ended without a restart. It refuses while a
task or a journalled operation runs: the restart would leave those to recovery.

Tables: `server_instances`, `mods`, `instance_mods`, `instance_datapacks`,
`resource_samples`, `java_runtimes`, `settings`, `scheduled_commands`, `operations`,
`player_fields`, `sessions`, `audit_log`.

`settings` holds one JSON value per key, each validated on every read so a stale or
hand-edited row falls back to defaults: the snapshot policy (global and per server), new
server defaults, Java defaults per version, learned Java requirements, saved console
commands, Chunky options and the CurseForge key (encrypted).

`instance_mods` carries `instanceId` as a plain column; that column *is* the relationship,
so there is no separate join table.

`resource_samples` is a fixed 24-hour window at 10-second resolution with no rollup. Old
rows are deleted on a timer. That is about 8,600 rows per instance, which SQLite does not
notice, and it avoids an entire downsampling subsystem.

---

## Monitoring

CPU and memory come from systemd itself: `systemctl show -p CPUUsageNSec,MemoryCurrent`,
which reads the cgroup. No agent, no separate monitoring stack, and it works whether or
not the server is cooperating.

`CPUUsageNSec` is cumulative, so CPU percentage is a delta between samples divided by
elapsed wall time. The first sample after a start has no predecessor and is skipped.

Because the same `systemctl show` call backs the status pills on every page, `unitState()`
caches for 1.5 seconds and caches the *promise* rather than the value, so several tabs
polling at once share one subprocess instead of racing. Anything that changes state —
start, stop, restart, reset-failed — clears the entry.

**History** (`history.ts`) keeps what happened over time: runs (`server_runs`: when a start
began, reached `Done (`, ended) and player sessions (`player_sessions`: join to leave). Every
30 s it reads each server's journal from where it got to (`server_instances.history_cursor`),
filtered with `journalctl -g` to systemd's start/stop lines, `Done (`, and join/leave lines
(`playerEventWithName`, which chat cannot fake). Reading from a stored position means events
while MineShell was down are caught up on, and the first read takes in what the journal still
holds. The position stored is the newest entry, read before the filtered read (matches newer
than it wait for the next call), so a server quiet for days is not rescanned from an old
match each time. A run ending, or the next one starting, closes any open session. Crashes use the overview's
rule (`lastcrash.ts`) on every run: a failure that is not exit 143 (SIGTERM, which only an
asked-for stop sends), or stopping on its own before `Done (`; each is put through the crash
analyzer once (a few per pass) and its verdict kept on the run. From it:
today's peak and time online (overview), playtime and last seen (Players), start times
(overview against the median of the five before, and per run in Logs).

**Heap and memory advice.** The cgroup's memory says nothing about the Java heap: the JVM
keeps heap it took, all of it at start with `-Xms` = `-Xmx`. `heap.ts` asks the JVM itself,
once a minute, over its attach socket as `jcmd <pid> GC.heap_info` does - without a JDK and
without flags (the hsperfdata file `jstat` reads is off under Aikar's
`-XX:+PerfDisableSharedMem`). A `.attach_pid<pid>` file in the server's folder plus SIGQUIT
makes the JVM open `/tmp/.java_pid<pid>`, read through `/proc/<pid>/root` because of
`PrivateTmp`; it then answers `VM.flags` (MaxHeapSize, once) and `GC.heap_info` (used, parsed for
G1, Parallel, Serial, ZGC and Shenandoah; Java 8 to 25). An unhandled SIGQUIT ends a process,
so it is never sent with `-Xrs`, `-XX:+ReduceSignalUsage` or attach disabled, to a JVM under a
minute old, or twice to one that did not answer. Samples (`heap_samples`) are kept 3 days.
`memoryadvice.ts` takes the highest hourly low (close to what survives a collection; G1
lets the heap fill before collecting, so peaks say little) as what a server needs: more when
that is over 70% of the heap or the journal has an `OutOfMemoryError` since the memory was last
changed (`memory.changedAt:<id>` in settings), less when the heap is over five times it
(suggesting three times, whole GB, at least 2 GB, leaving the machine 2 GB). Advice only: the
overview links to Settings, where "Use N GB" fills the field.

---

## Mods and packs

`ModProvider` is one interface with three implementations: Modrinth (its own API),
CurseForge and FTB (both through the `api.modpacks.ch` mirror; with a CurseForge key, pack
metadata comes from CurseForge's official API, the install target still from the mirror).
Adding a source means implementing search, project, versions and version, and adding it to
the registry. Packs and single mods have separate registries (`getProvider` /
`getModProvider`): Modrinth serves both from one API, but CurseForge mods come from
different mirror endpoints than its packs.

Pack mods are tracked by where they came from. A CurseForge pack names the project and
file behind every jar (the mirror's file list and `manifest.json` both do), so those are
recorded as CurseForge mods; everything else is identified by hash against Modrinth, and
whatever neither recognises is tracked as manual.

Pack import detects the format from what is inside the archive: `modrinth.index.json`
means an mrpack, `manifest.json` means CurseForge. Both resolve to the same internal
`ParsedPack` shape, so downstream code does not care which it was.

Details worth keeping:

- mrpack files carry per-file environment flags. Files marked `env.server === "unsupported"`
  are skipped, otherwise you install a pile of client-only mods that crash on boot.
  modpacks.ch file lists flag `clientonly` files, which are skipped the same way.
- CurseForge manifests say nothing about sides and pack metadata can be wrong, so after a
  pack install or version change the jars it added are checked (`clientonly.ts`): Modrinth
  lists the project as `client_only` (looked up by hash, whatever the source), the jar
  declares a client environment, or, for a jar tracked as CurseForge, CurseForge tags its
  file client-only - or tags the newest file for that Minecraft version and loader so,
  since authors often tag only their newest file (one file list per project). Those are disabled, not deleted, unless an enabled mod
  requires them, and the install's status says which. Jars that were already there are
  left alone, so a mod someone re-enabled stays enabled.
- `overrides/` and `server-overrides/` both get applied, with server-overrides winning.
- Data packs from the mod browser (Modrinth releases tagged `datapack`) go into the world's
  `datapacks/` folder and are tracked in `instance_datapacks`, apart from `instance_mods`,
  whose rows all live in `mods/`.

Operations that rework an instance's files - pack version change, loader version change,
moving to another Minecraft version or loader (`migrate.ts`), Cleanroom migration and
revert, mod updates, first install, world changes and snapshots -
are journalled in the `operations` table (`operations.ts`). The journal row records what
was there before; every file move is a rename into the operation's own folder, so what
already moved is read from disk; and the operation's result is written to
`server_instances` in the same transaction that deletes the row. On startup, `recovery.ts`
rolls back any operation a previous MineShell process left unfinished (the same restore
code as a failure while running), marks interrupted first installs failed, and releases
servers whose operation had committed.

**Config edits across a pack change** (`configmerge.ts`). A pack change moves every folder
the new version ships to `old-configs/<date>-<version>/` and writes the pack's fresh. The
pack's own copies of what it ships outside `mods/` and the world are kept as
`.mineshell/pack-base.zip` (written at install and at every change, tagged with the pack
version the row records, so a base left by a change that rolled back is not used; files over
4 MB by hash only). With that base each moved file is sorted: unedited (the new pack's
stands), edited and unchanged by the pack (the user's comes back), changed by both (a line
merge; where both changed the same lines the pack's are used, so the server starts as the
pack intends, and the file is listed), and files the pack never had (carried back unless the
new version ships one there). A server without a base reads its installed version's
overrides once. The merge runs inside the journalled change; its report, with the base and
pack sides of every file a review needs, goes to `.mineshell/config-merges/<stamp>/`, and
the Modpack settings show it with a compare view and "use mine / use the pack's".

Mods are always downloaded fresh per instance. No shared cache, no symlinks. This is
deliberate: modpacks sometimes ship a patched jar under the same version label as the
upstream one, and a shared cache would serve the wrong file with no way to tell. Disk is
cheaper than that bug. A `hash` column exists on `instance_mods` for a future opt-in
cache-by-hash, but nothing reads it yet (the update check hashes the jars on disk).

**The mod bisect assistant** (`bisect.ts`, Mods tab) finds the mod, or pair of mods, a crash
comes from. Suspects are the enabled mods minus a keep-on list (Cleanroom's own fixes ticked
by default). The first test starts with all of them (the problem must show), the second with
none (it must not); then the suspects are halved and the half that still shows the problem
searched, and when neither half does alone, one half stays on while the other is searched,
then the partner (delta debugging): about 2 + log2(n) starts for one culprit. A test turns a
mod on with what it depends on (the jars' declarations, as `crashdiag.ts` indexes them), a
half that cannot go without the other is searched with its dependencies along, and a failed
test the crash analyzer explains as "X needs Y, which is disabled" teaches that dependency
and is repeated. "The problem" is a crash before `Done (`, or optionally a text in the log
(watched for 30 s after `Done (`); a start that does not finish within max(10 min, 3x the
usual start) counts as the problem.

Test runs never open the real world: `level-name` points at a throwaway world, since a world
loaded with mods missing loses their blocks and items. `config/` is copied aside (mods
rewrite configs when others are missing), crash restarts are off, and scheduled restarts and
commands skip the server; ordinary start/stop/restart refuse while it searches, as do the
Mods tab's changes. All of it is journalled (`bisect`) and put back by the same
`restoreBisect` at the end and by recovery after a crash, which also clears systemd's failed
state. Runs started during a search are marked (`bisect_sessions`, `server_runs.bisect`) and
stay out of crash history, start times, the last-crash box and diagnosis.

**Server icons** must be 64x64 PNGs. Scaling happens in the browser (`lib/shared/servericon.ts`),
which decodes every format pack icons come in (PNG, WebP, JPEG); the server has no image
library. A pack server's first overview without an icon applies the pack's icon (`packicon.ts`:
MineShell fetches it from the provider and passes it through, so the canvas may read it),
once: a `packicon.tried:<id>` setting, also set by replacing or removing the icon, keeps it
from coming back.

**Client pack export** (`packexport.ts`, the server's Export page) builds a pack for
players' launchers: a Modrinth `.mrpack`, a CurseForge zip or a Prism Launcher instance,
as a task whose result is downloaded from `/api/instances/[id]/export?task=` for an hour
(the page starts that download itself when the task finishes; files are in `$DATA/tmp/exports/<task>/`).
In it: the mods ticked on the form (all by default: server-only ones do nothing on a
client, and a singleplayer test world then matches the server), each as on the server except client-only
ones, which come back enabled; the folders ticked; and for a server installed from a
provider pack, the pack's client-side files the server never got - mods the pack marks
client-only (`env.server: unsupported` in a .mrpack, `clientonly` in the mirror's lists)
and override files the server lacks (`client-overrides/`, options.txt, shaders). A pack mod
missing on the server that is not client-only was removed on purpose and stays out. Files
are linked where the format can: Modrinth's CDN URL (found by the jar's sha512) in a
.mrpack, whose spec allows only cdn.modrinth.com, GitHub and GitLab hosts; project and file
id in a CurseForge manifest, which cannot say "disabled", so disabled mods are bundled as
`.disabled` files. Everything else is bundled in the overrides. Prism bundles everything;
its loader is `mmc-pack.json` components, and for Cleanroom the patches and components come
from the instance Cleanroom publishes with each release (0.5.x on). Modrinth and CurseForge
packs cannot name Cleanroom, so they ask for Forge 1.12.2 (the version migrated from, else
14.23.5.2860) and the page says so.

---

## Worlds

Snapshots live inside the server folder, `.mineshell/snapshots/<id>/`, with the world
folders at their relative paths and a `manifest.json`; one is assembled as `<id>.partial`
and only counts once renamed. Before MineShell's own risky operations the world is copied
into one (reflinks where the filesystem has them). The World tab's operations - reset,
replace, restore, reset or restore one dimension, prune chunks - instead move what they
replace into the snapshot, so keeping the old world costs no copy; they share one journalled
shape (`world-change` in `world.ts`), which a crash rolls back.

**Scheduled snapshots** (`snapshotschedule.ts`, run from the scheduler's 30 s tick): per
server, daily at a time or every N hours (`snapshots.schedule:<id>`, the next slot in
`snapshots.next:<id>`; a slot missed while MineShell was down moves on, it is not fired at
start). A stopped server is copied as it is. A running one is either copied live -
`save-off` and `save-all flush` over RCON, then waiting until no world file changed for 5 s
(at most 2 min: 1.12 Forge writes chunks on its own thread after `save-all` answers, and
mods can write late), the copy, `save-on` in a `finally` - or warned at 15/10/5/1 minutes,
stopped, copied (the server marked busy, so nothing starts it mid-copy) and started again
whether or not the copy worked. Both run as a task under a `scheduled-snapshot` journal;
recovery sends `save-on` to a server left with saving paused and starts one left stopped.
Retention is the ordinary policy, so frequent scheduled snapshots push out older
pre-operation ones once over the limits (pin one to keep it).

"Every N hours" falls on the clock (`clockSlot`: multiples of N from midnight up to a day,
whole days at midnight; the world map's schedule uses it too), and the next slots are worked
out again at every start. A slot is skipped, unless turned off (`skipIdle`, on by default),
when nobody was online since the newest full snapshot: the player sessions read from the log,
and RCON's `list` for who is on now. Not by file times: a running server rewrites its spawn
area with nobody on. A due slot waits while the server is starting or stopping, has not
logged `Done (` (`runFinishedStarting`), counts down, or has a scheduled restart within its
warning time; after 30 minutes the slot is let go. The scheduled restart in turn waits while
the server has a journalled operation (a snapshot under way): a restart during a live copy
caught the world mid-write. A failed `save-on` is only reported when the same run of the
server is still going (`activeEnterTimestamp`): a restarted server saves anyway.

Dimensions are found on disk (`dimensions.ts`): a folder holding `region/` or `entities/`.
The overworld is the level folder's own `region/`, `entities/` and `poi/`, so resetting it
keeps `level.dat` and player data. A snapshot of only some folders is marked `partial` and
restores only those.

How many snapshots stay is a policy (`snapshots.ts`): the newest few full and partial ones
always, more while they fit a storage budget per server, set globally and overridable per
server. A copy that would leave the disk nearly full is refused.

The server is stopped for all of this; only downloading a running world does `save-off`,
`save-all flush` and `save-on`.

---

### The world map

`worldmap.ts`, the server's Map tab. For Minecraft 1.13 and newer MineShell runs BlueMap's
standalone CLI (downloaded from its GitHub releases into `$DATA/tools/bluemap/`, SHA-256
checked, on the newest installed Java 21+): it reads the region files and the server's mod
jars (`-n mods/`, for modded blocks' models and textures) and writes a static web map.
Everything per server is in `$DATA/maps/<id>/` - `config/` (written fresh before each
render: one map per dimension with a namespaced id, BlueMap's own web server off),
`data/` (caches and the Minecraft client jar BlueMap downloads, only with
`accept-download`, which follows the per-server EULA answer), `web/`. MineShell serves
`web/` itself under `/instances/<id>/map/view/`, behind its login, the way BlueMap's server
would: a file, else its `.gz` with `Content-Encoding: gzip` (tiles and textures are stored
compressed), else 204 for tiles and live data. A render is a task (one per server; a running
server is told to `save-all` first) and only redraws what changed unless forced. An optional
schedule per server (off, every N hours, daily at a time; in the `map:<id>` settings row) is
checked on the scheduler's tick; slots missed while MineShell was down move forward.

Map mods: Forge/Cleanroom 1.12.2 is mapped by Dynmap with DynmapBlockScan (no standalone
renderer reads RoughlyEnoughIDs/JEID worlds; without BlockScan modded blocks are black), and
1.13+ can add the BlueMap mod for a live map. MineShell installs them (Dynmap's newest
1.12.2 build from CurseForge, BlockScan from dynmap.us, BlueMap from Modrinth), gives each
server one port of its own for the mod's web server (`modPort`, from 8123, not another
server's), and writes it with a localhost-only bind into the mod's config before every start
(`applyMapModConfig`; the files exist only after the mod's first start, which uses its
default port). `/instances/<id>/map/live/` passes requests through to that port behind
MineShell's login - bodies streamed, MineShell's own cookies and auth headers not passed on.

Simple Voice Chat (`voicechat.ts`) listens on a UDP port of its own (`port` in
`config/voicechat/voicechat-server.properties`, 24454 by default; `-1` is the game port's
number), which clients reach directly, not through the game connection. Two servers with the
default both want 24454 and the second stops itself at start, so `start()` refuses while a
running server with the same port, or anything else, holds it (a UDP bind test), and a copy or
a pack install gets a free port written into the config (from 24454 up, none another server's
or bound; before the mod's first start the file holds just that key, which the mod fills in).
The overview's firewall hint and the server's Network settings show the port.

### playit.gg tunnels

`playit.ts`. One playit agent per machine, a user unit `<prefix>-playit.service` (enabled,
`Restart=always`, logs to the journal) running the pinned release
(`$DATA/playit/playit-<version>`, SHA-256 from GitHub's release digests) with its key in
`$DATA/playit/agent.key` (0600) and its IPC socket in `%t` - a path under `$DATA` can exceed
a socket's 108-byte limit. Linking is playit's claim flow (`/claim/setup` until the user
approves `https://playit.gg/claim/<code>`, then `/claim/exchange` for the key), claimed as a
`self-managed` agent, which may create tunnels. Each public server has one Minecraft Java
tunnel (`/tunnels/create`; the v1 endpoint rejects every body) to `server-ip` or 127.0.0.1 on
its game port, remembered in the `playit:<id>` settings row. Before every start the tunnel is
pointed at the current port with `/tunnels/update` (same tunnel, same address; a changed port
only applies on restart); one that is gone from the account (`/tunnels/list`, not the run
data, which lists new tunnels a moment late) is forgotten. Deleted with the server, when
switched off, and on unlink (the agent stays on the account: the API cannot delete it).
The run data (tunnels, `display_address`, Premium) is kept 15 s and streamed to pages.
Where the agent connects out ("Connects through", free) is separate from a tunnel's region
(where players connect, Premium): `/agents/routing/set` with `Automatic` or a location from
`/info/pops` (`{type: "Pop", details}`); the running agent moves over by itself, and
`/agents/routing/get` answers only the resulting addresses, so the choice is kept in the
`playit` settings row. playit refusing the agent is only in its log (`AgentDisabledOverLimit`: over the account's
agents, two on a free one), so the status reads the last lines.

## Safety and confinement

**Path traversal.** Every file operation goes through `safeJoin()` in `files.ts`, which
resolves the result and verifies it is still inside the instance directory. The file
browser, uploads, mod deletion and the text editor all use it. A dropped folder's files
keep their paths inside it (`uploadPath`, which refuses `..` steps). Deletion additionally
refuses to operate outside `INSTANCES_DIR`, so a corrupt database row cannot point
`rm -rf` at something interesting.

**Secrets.** RCON passwords (and a CurseForge key set in Settings) are AES-256-GCM
encrypted with a key in a `0600` file (`secret.key`) beside the database. Losing the key
means regenerating RCON passwords, which a server's Settings can do (Network, "Generate a
new password on save").

**Cross-site requests.** A state-changing request whose browser `Origin` names another host
is refused (`guard.ts`). Only the host is compared, against `Host` and `X-Forwarded-Host`,
because MineShell is reached by raw IP, other hostnames and through TLS-terminating proxies;
SvelteKit's own full-origin check is turned off for that reason.

**Auth.** A single admin password, scrypt-hashed, with session cookies and a per-IP
attempt throttle. The original notes left this open, wondering whether LAN-only made it
unnecessary; it is on by default because "LAN-only" tends to stop being true — a guest
device, an IoT box, a Tailscale exit node — and this application can delete a world.
`MINESHELL_AUTH=off` disables it and says so plainly on the settings page.

---

## Frontend

SvelteKit 3, Svelte 5 runes, no UI framework. Server state comes from `load` functions and
form actions; only the genuinely live things (console, stats, task progress) use SSE.

There is no separate REST API layer. The notes reasoned that no other consumer is planned,
so endpoints (`src/routes/api/`) exist only where a form action cannot do the job: SSE
streams, file and world downloads (and a folder's listing, for folders opened in place in
Files), a world upload streamed to disk (a form body would be
held in memory whole), console commands and saved commands sent from the console, and the
search and preview endpoints the browse-and-install forms call as you type.

**A server's Settings** is one page with nine tabs (server.properties and MineShell's own
settings together) and one save bar. Each section is still its own form posting to the
action that saves it (`general`, `properties`, `network`, `runtime`, `limits`, `restarts`,
`console`, `snapshotPolicy`); the bar submits the changed ones in turn and stops at the
first refusal, opening its tab. That works because those actions keep the current value
of any field missing from the form: `properties` writes only the keys posted, `network`
and `restarts` fall back per field, `runtime` keeps the pinned Java when no Java field is
posted. Whether a section has unsaved changes is worked out from its fields against the
loaded data, not from the DOM, and a reload copies in only the values that changed on the
server, so an action elsewhere on the page (a scheduled command added, a section saved)
does not wipe edits that are not saved yet. Every section stays mounted and is hidden when
its tab is closed, so the search can look through all of them. Things that act at once
(installing a loader version, a pack change, Cleanroom, the icon, presets, scheduled
commands, copy and delete) keep their own buttons.

**The instance header** carries start, stop, restart and the delayed variants on every
tab. Its forms post to the overview's actions; an enhanced form posting to another page
would navigate there, so the header applies the result itself and reloads in place.
Kit 3 counts the query as part of the page, so `action="?/x"` also lands somewhere else
on a page with one (`?path=`, `?tab=`, `?range=`): every page imports `enhance` from
`#lib/shared/forms.js`, which keeps a form posting to its own path on the current URL.

**Slow data is streamed**: a `load` returns what takes long (journal reads, version lists
fetched from the loaders' servers, a mod scan, the overview's disk walk and last-run crash
check, the Spark check every tab's header makes) as an unawaited promise, so the tab opens at
once with a placeholder. A plain `{#await}` shows its placeholder again on every reload
(a form action, the header's `invalidateAll`), which blanked the Logs viewer and lost its
scroll; `streamed()` (`lib/shared/streamed.svelte.ts`) keeps the last value while the next
one loads and shows the placeholder only when it was loaded for something else (another
log picked).

**The notification center** (top bar, `NotificationCenter.svelte`) follows the task stream
(`/api/tasks?stream=1&brief=1`, without logs) on every page: running tasks with progress
and Cancel, tasks finished in the last half hour (the server keeps them that long),
an unread count kept per browser. A task that finishes while the panel is closed becomes a
toast and reloads the page data. Toasts (`lib/shared/toasts.svelte.ts`) are also where
results go that have no place on the page, like a save in the player editor: closable,
and anything but an error closes itself after 8 s. The Activity page keeps the logs.

Phones: layout changes for narrow windows sit under `@media (max-width: 60rem)` (the rail
slides in, the instance header stops sticking, tab bars scroll with a fade, tables scroll
in their own box), and touch-only changes under `@media (pointer: coarse)` (16 px text in
fields, which stops iOS zooming in on focus; finger-sized buttons; a larger invisible hit
area for controls marked `hit-area`; tapping an element that only has a `title` shows it in a
bubble, `TapTips.svelte`), so a narrow desktop window with a mouse is unaffected by the second set.

Styling is one stylesheet of custom properties. Two rules carry meaning rather than taste:
monospace is used only for machine output — paths, versions, ports, log lines, metrics —
and never for MineShell's own writing; and motion appears only on state change, never as
decoration, because a page that animates while a server is crashing is a page you stop
trusting.

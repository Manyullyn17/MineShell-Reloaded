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
ExecStart=/bin/sh -c 'f="<data>/units/%i.once"; a=; if [ -f "$f" ]; then a=$(cat "$f"); rm -f "$f"; fi; exec "$MS_JAVA" $MS_JVM_ARGS $a $MS_LAUNCH_ARGS'
```

Four things about that line matter.

**`exec`.** Without it the shell stays as PID 1 of the service and Java becomes its child.
systemd would then be watching the shell, not the server, so a crashed Java process would
look like a healthy service and `Restart=on-failure` would never fire. This is the same
reason the original design's tmux wrapper had to go.

**`/bin/sh -c`.** JVM arguments need word splitting. systemd's own `ExecStart` does not
split variables, so `$MS_JVM_ARGS` would arrive as one enormous argument. A shell does the
splitting, then removes itself with `exec`.

**Quoting.** `"$MS_JAVA"` is quoted because a path may contain spaces; the argument
variables are deliberately unquoted because they must split. The line never uses `${...}`:
systemd substitutes that form itself, even inside a quoted word, before the shell runs.
Splitting is on whitespace only: quotes in JVM arguments would be passed on as they are, not
grouping (`-Dx="a b"` is two arguments), so saving refuses them (`argsProblem`, ROADMAP). In `<id>.env` itself systemd takes a backslash as an
escape, so `writeUnitEnv` doubles it, and puts a line break in a value as a space: it would
otherwise start a line setting a variable of its own.

**One start's arguments.** `<id>.once` holds JVM arguments for the next start only
(`writeOnceArgs`); the start reads and deletes it, so a restart by systemd after a crash, or
any later start, runs without them. Every start and restart through MineShell writes or
removes it, so a file left by a start that never ran is not picked up later. The template
is `Type=simple`, so `systemctl start` returns once systemd forks, possibly before the
environment file is read: putting a one-off argument into `<id>.env` and taking it out again
after the start would race.

### Forge's startup questions

Forge before 1.13, and Cleanroom, can stop loading a world to ask on the console: about
registry entries (blocks, items, sounds...) no installed mod provides any more, whole
missing registries, or a damaged level.dat whose backup it would use (`StartupQuery.confirm`;
read from Forge 1.12.2-14.23.5.2860 and Cleanroom 0.5.17 with javap). It reads the answer
only from the console's input (`/fml confirm`, `/fml cancel`, polled from the dedicated
server's pending command list, which only stdin feeds); a unit has no stdin, and RCON starts
after the world loads. So the server would wait forever. The way through is
`-Dfml.queryResult=confirm`, which Forge takes as the answer to whatever it asks, and
MineShell passes it for one start only: set for good, a mod gone missing by mistake would
later have its blocks removed without anyone being asked.

`forgequery.ts` watches a starting server's journal for the prompt with `journalctl -g`,
continuing from a cursor so the overview's polls read only new lines, and stops looking
once the run reaches `Done (`. The question's lines are one log message, which journald
stores with one timestamp, so they are read back by that timestamp alone. The overview
shows what is missing; confirming stops the server (the world is not loaded yet), takes a
snapshot unless unticked, and starts it once with the answer; Stop leaves the world as it
is. "World saved with mod X which appears to be missing" is only logged in 1.12, not asked.
Giving units a stdin (a FIFO socket unit) was considered: it answers without a second
start, but its buffer outlives a run, so an answer could reach the next one.

### Drop-ins

`Restart=` cannot come from an environment file — systemd reads unit directives before the
environment file exists. So per-instance restart behaviour is written as a drop-in at
`<unit>.d/restart.conf` next to the template instead, and `writeRestartPolicy()` owns that
file. Memory and CPU caps are a second drop-in, `limits.conf` (`MemoryMax=`, `CPUQuota=`),
from `writeResourceLimits()`. Unlike everything else in the unit, the caps reach a running
server at once: `daemon-reload` re-applies cgroup settings to active units (checked for both,
and for removing them). So the memory cap is checked against the bigger of the saved heap and
the one the running process started with (`runningHeapMb`, its `-Xmx` from
`/proc/<pid>/cmdline`), which differ until a restart. The floor is heap + 10% + 1 GB
(`minMemoryLimitMb`, `lib/shared/memorylimit.ts`; the measurements are in its comment). A
kill at the limit is systemd's "killed by the OOM killer" line in the run's journal, which
crash diagnosis names (`memory-killed`). Starting by hand checks the memory first
(`memoryguard.ts`): this server's ceiling plus what the running ones can still grow into,
against MemAvailable, and all their ceilings against the cap on all servers below; past
either, the page asks before starting anyway (`force`). A start nobody watches (schedules,
crash restarts, boot) is never held up by it.

One cap on all servers together (`servercap.ts`, MineShell settings > System) sits on the
slice they share: the template says `Slice=app-<prefix>.slice` (`serverSliceName`, escaped
as systemd escapes a '-'), which is the slice systemd's user manager gives a template's
instances by default, so running servers are already in it (checked on systemd 255; an
older default moves them at their next start, and the settings list any running server
whose cgroup is outside it). The slice unit file carries `MemoryHigh=` (soft: past it the
kernel reclaims and throttles inside the slice, nothing is killed; it cannot shrink a heap
Java holds) and `CPUQuota=`; with neither set the file is removed and systemd makes the
slice by itself. Like the drop-ins it applies to running servers on daemon-reload (checked
both ways, and for removing it). Written when saved, at boot and when the template is
installed; a slice file MineShell did not write is never replaced.

Notifications (`notifications.ts`) go to MineShell's destination (a `settings` row) and/or a
server's own (`instance_notifications`, with `also_global`), each with the kinds it is sent.
Reported by the run history (start, stop, join, leave; crash and memory kill after the crash
diagnosis, with its cause), the scheduler (stuck starting, scheduled restart, a scheduled
snapshot that failed or was skipped, a disk running low), the backup copies (once per run of
failures) and the update check. A kind added later and on by default
(`ADDED_LATER`: backup, disk) is on for destinations saved before it too; turning it off is stored
as `!kind`, which older versions skip. Nothing older than 5 minutes is sent (the history catches up after downtime), repeats
of a problem within 10 minutes fold into the next message, and sending never blocks the
caller. Addresses are encrypted, only a hint goes to the browser, and requests to local
addresses are refused unless allowed (`assertPublicUrl`), since a server admin chooses its
address. Discord messages set `allowed_mentions: { parse: [] }`.

Every request to the outside goes through `outboundFetch` (`outbound.ts`), which keeps per
service (hosts grouped by suffix: api/cdn.modrinth.com are Modrinth) the last answer and the
last failure, in memory on globalThis: no answer, a 5xx or a 429 fails, any other status is an
answer (a 404 says the service works); a request MineShell aborted counts as neither. Activity
lists them and warns while one fails. Only names, times and a short reason are kept, never
URLs, which can carry tokens. The local map proxy (`/maps/<token>/live/`) is not outbound and does
not use it. The global `fetch` itself is the undici package's (`undicifetch.ts`, set by
hooks.server.ts before anything runs): Node 22's and 24's own could end the process on a
download from a host that closes the connection after the file. Only `fetch` is swapped, not
Request or Response; a Node `FormData` body is copied into undici's, which is the only kind it
sends. The template itself says `Restart=on-failure`, so a server
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

"Every N hours" falls on the clock, as scheduled snapshots and map updates do (`clockSlot`
in snapshotschedule.ts): every 6 hours is 0:00, 6:00, 12:00 and 18:00, not 6 hours after
whenever the last restart was (before 2026-10-20 it was, and drifted; a slot set that way is
moved onto the clock once at startup). The forms offer only intervals that come out even
(divisors of 24 hours, whole days; `lib/shared/presets.ts`), and warnings only at the marks
that are sent, as fixed choices; a stored value outside them shows as it is. Scheduled
console commands do the same in minutes (`minuteSlot` in scheduledcommands.ts: every 15
minutes is :00, :15, :30, :45), offering minutes that divide an hour and hours that divide
a day; one set to another interval before 2026-10-20 keeps counting on from its last run.

### Servers after a reboot are started by MineShell, not enabled in systemd

The template has `WantedBy=default.target`, so `systemctl --user enable` would bring a
server back at boot without MineShell. It is not used: systemd would start the server
before MineShell's recovery runs, so a power cut in the middle of a pack change would boot
a half-changed server; it would start with whatever env file was last written (a start
resolves Java and rewrites it); and every server would load at once. Instead `bootstart.ts`
runs at MineShell startup, after `recoverInterruptedOperations`. It compares the boot, the
kernel's boot id (`/proc/sys/kernel/random/boot_id`) and when PID 1 started (`/proc/1/stat`),
with the one stored in `settings` (`host.bootId`): only a new boot starts anything, so
restarting MineShell never does. PID 1 is there for containers (Proxmox LXC, Docker, LXD),
which share the host's kernel and boot id: restarting one restarts only its PID 1. An id
stored before that (the kernel's alone) counts as the same boot while the kernel's matches. Then
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

MineShell keeps one RCON connection per server open for as long as the server keeps it
(Minecraft never drops an idle client); the server logs every connection, and one per
command was several a minute. Commands to one server run one after another, because
vanilla collects every client's output in one shared buffer. The connection is given up
after a timeout (a late answer must not become the next command's) and opened again on the
next command; a command sent on a connection that turned out to be closed (the server
restarted meanwhile) is sent once more on a new one. Answers over 4096 characters come in
several packets; once a full-size one arrives, a request of an unknown type is sent, and
its "Unknown request" answer marks the end. Only one packet is ever in flight: the server
closes the connection when a read holds more than one.

RCON answers are used for things like the online player list and kick confirmation. A
command typed into the console shows its answer in the view, marked `[rcon]`, but it is
never written to the journal, which stays a faithful log of the server.

The view itself (`lib/shared/consolelines.ts`) sorts lines by level, folds stack traces
under the error that logged them, strips the ANSI colours modern Forge prints, and hides
the server's own lines about RCON connections by default (older MineShell versions opened
one per command, and those runs are still in the journal). Chat lines (`<name> text`, `[Not Secure] <name> text`, `* name`,
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
GitHub's release list (drafts and pre-releases left out; the highest version is the latest)
every 12 hours, keeping the answer in `settings` (`update.check`): the latest, and every
release that has its archive, which Settings > Updates lists with their notes. The update downloads the archive, checks it against the
published SHA-256, takes `install.sh` out of that archive and runs it with `systemd-run
--user` as a transient unit (`<service>-update-<ms>`): the installer restarts MineShell,
which kills its own children. `update.run` records it before it starts; the restarted
MineShell settles it as done when it runs the new version, and the running one as failed
(with the unit's journal) once that unit has ended without a restart. It refuses while a
task or a journalled operation runs: the restart would leave those to recovery. Before the
installer runs, the database is copied (SQLite's online backup) to `$DATA/db-backups/`,
newest five kept. The scheduler's tick also makes one a day (`dbbackups.ts`,
`daily-<local date>.db`, newest seven, written as `.part` and renamed), kept apart from the
pre-update ones so neither pushes the other out. Never a file copy: in WAL mode the file alone
can miss what is still in `-wal`.

Going back to an older release (`startDowngrade`) is the same install with the older archive
and its own installer. Which ones are offered is a rule (`mayGoBackTo`): any while on 0.x; from
1.0 on, those of the running major and the newest release of the one before (the way out of a
bad .0), refused otherwise, with the installer's `MINESHELL_VERSION` as the unsupported manual
way. That way out needs every migration since the last 0.x to be downgrade-safe, which a test
holds (`db/migrate.test.ts`) for all of 1.x (DEPLOYMENT, "What 1.x keeps", is the promise). The older installer's environment
variables have not changed since 0.13. Migrations only go forward and the older version runs
on the database as it is: it skips `_migrations` rows it does not know, and Drizzle's selects
name their columns, so added tables and columns go unnoticed. Each migration's first line says whether that holds for it (`-- downgrade:
safe` or `-- downgrade: unsafe - <why>`; no line counts as unsafe, and a test requires the
line). `planDowngrade` asks GitHub for the target tag's `migrations/` list; applied ones it
lacks are read from this version's own files (or GitHub's, for ones a newer release applied
before going back once) and any unsafe one refuses. Only 0019_users is unsafe: it moves the
admin password into `users`, so nothing before 0.13 can be gone back to. The backup is not
restored by MineShell (servers made since would be missing from it); DEPLOYMENT says how by
hand. Releases before 0.24.0 (`HISTORY_SINCE`) have no list: from there only "update to the
latest" or the installer with `MINESHELL_VERSION`. Data on disk an older release handles
differently (not the database) is listed in `LEFT_BEHIND` with the release that brought it,
and the dialog says each one going back past it: shared snapshot files (an older retention
counts them in full and can delete snapshots to fit its budget; its Files tab writes into
files) and backup folders, both 0.32.0. `since` has to be the release that ships it: if the
next release is not 0.32.0, change it there.

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
asked-for stop sends), or stopping on its own before `Done (`, or logging the game's crash line
("Encountered an unexpected exception", kept as `crash_logged_at`) however it ended; each is put
through the crash analyzer once (a few per pass) and its verdict kept on the run. A process can
hang on after its crash line (a mod's shutdown handler failing: Cleanroom 0.5.2 + MeatballCraft
did); still running a minute after it (`hungAfterCrash`), the overview shows it as crashed, with
the diagnosis, instead of running or "stuck starting". From it:
today's peak and time online (overview), playtime and last seen (Players), start times
(overview against the median of the five before, and per run in Logs). The overview's Recent
crashes can be cleared once a start after the newest one got to `Done (` (a time per server in
settings, `crashes.cleared:<id>`; the runs stay, Logs lists them all), and clear on their own
when the start after a one-click fix gets there (`crashes.fix:<id>`, set by `modFix`).

**Starting vs running.** systemd calls the unit active as soon as Java runs; a server is
"Starting" until its run logged `Done (` (`startphase.ts`, used by `summarise`): the run's
`server_runs.done_at` when the history has it, otherwise `journalctl -g` from the run's start
(milliseconds, as it reads only that run's time). A finished start is remembered per run, "not
yet" for 2 s (pages poll). Uptime counts from `Done (`, and the overview says "started in"
only for the running server's own start, "last start took" for an earlier one. The other
way round, a server told to `stop` over RCON (the Stop button, or `stop` typed in the console)
is "Stopping" while MineShell waits for its process to exit (`pendingStops`, `awaitStop`), which
on a big pack's save takes a while; systemd's own stop shows as its `deactivating`. A running
server that logged "Server empty for N seconds, pausing" (Minecraft 1.21.2+'s
`pause-when-empty-seconds`, offered in Settings > Performance only from that version) is
"Paused (empty)": history.ts keeps the time on the run (`server_runs.paused_at`) and a join
clears it, since the game logs nothing when a player wakes it; `pausedSince` reads it for
`summarise`, so it lags by up to a history read (30 s) both ways.

**Heap and memory advice.** The cgroup's memory says nothing about the Java heap: the JVM
keeps heap it took, all of it at start with `-Xms` = `-Xmx`. `heap.ts` asks the JVM itself,
once a minute, over its attach socket as `jcmd <pid> GC.heap_info` does - without a JDK and
without flags (the hsperfdata file `jstat` reads is off under Aikar's
`-XX:+PerfDisableSharedMem`). A `.attach_pid<pid>` file in the server's folder plus SIGQUIT
makes the JVM open `/tmp/.java_pid<pid>`, read through `/proc/<pid>/root` because of
`PrivateTmp`; it then answers `VM.flags` (MaxHeapSize, once) and `GC.heap_info` (used, parsed for
G1, Parallel, Serial, ZGC and Shenandoah; Java 8 to 25). An unhandled SIGQUIT ends a process,
so it is never sent with `-Xrs`, `-XX:+ReduceSignalUsage` or attach disabled, to a JVM under a
minute old, or twice to one that did not answer. Samples (`heap_samples`) are kept 14 days.
The overview's heap size is the running process's own `-Xmx`, not the saved setting, which
applies from the next start (both are shown while they differ).
`memoryadvice.ts` takes the highest hourly low (close to what survives a collection; G1
lets the heap fill before collecting, so peaks say little) as what a server needs: more when
that is over 70% of the heap or the journal has an `OutOfMemoryError` since the memory was last
changed (`memory.changedAt:<id>` in settings), less when the heap is over five times it
(suggesting three times, whole GB, at least 2 GB, leaving the machine 2 GB). Less needs 5
hours with players online (`player_sessions`), counted in sampled minutes, on at least 3
days with 20 minutes or more: an empty server holds far less than a busy one, so idle hours
alone say nothing about what it needs, though they can show it short. Advice only: the
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
- Downloads (`downloadPackFiles`): CurseForge jars come from CurseForge's CDN, never from
  modpacks.ch (only FTB-hosted configs and jars do, from `dist.modpacks.ch`). The mirror and
  the API hand out `edge.forgecdn.net`, which only redirects to `mediafilez.forgecdn.net`, so
  every CurseForge file gets the latter as a second, hash-checked source. A file-list entry
  without a URL is kept (looked up by its CurseForge ids, else reported), never dropped.
  Required files that still fail are written to `.mineshell/missing-downloads.json` with a
  CurseForge file page each (`packs/missing.ts`); the overview lists them with links and a
  "Try again" that tracks what arrives as pack mods. A file in place drops off the list, and
  the next install or pack change replaces it.
- Data packs from the mod browser (Modrinth releases tagged `datapack`) go into the world's
  `datapacks/` folder and are tracked in `instance_datapacks`, apart from `instance_mods`,
  whose rows all live in `mods/`. Their updates (`checkDatapackUpdates`/`applyDatapackUpdates`
  in modupdates.ts, the Data packs sub-tab) list the project's data pack builds for the
  Minecraft version and pick as for mods; installing a version replaces the older file
  after downloading the new one. A world-generation pack the world has loaded can stop it
  loading when a biome it named goes away: it starts unticked, needs the server stopped,
  and takes the snapshot first. Not journalled: one file per pack, old one kept until the
  new one is in.

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
The preview lists the user's own files in the folders that move (`ownFiles`: not in the
installed version, so added by hand or written by a mod at its first start; mod-written
configs are why it is a count per folder plus a list): the ones that come back, and the ones
where the new version ships a different file, each with a "keep mine" tick (`keepOwn`,
default off, so the pack wins as before; a kept one is recorded as resolved `mine` in the
report). Without any base nothing tells the user's files from the pack's and no merge runs:
the files the new version does not ship are offered to bring back, otherwise they stay in
old-configs only. Only paths the plan offered are copied, from old-configs, inside the
journalled change.

**Rolling a pack change back** (`packrollback.ts`). Each committed change writes a
`pack_changes` row in its commit transaction (`commitOperation`'s `also`): the version and
Minecraft it came from, its old-configs folder, which top-level entries it moved there and
which it created, the snapshot it took, the user's mods it updated, and (after the sync) the
user's mod files as it left them. A rollback of the newest change is a pack change back to
`from` with `rollback` set: the entries it moved come back from that old-configs folder,
the ones it created go, the ones it never touched stay as they are - copied, never moved,
so the journal still restores everything if it fails - and no merge runs. The current
configs go to a new old-configs folder as in any change, and the rollback is itself a
recorded change. The user's own mods stay (listed in the form: updated by the change, or
changed since, by file name against the record). With "put the world back" the
world-change restore of the snapshot runs as its own task after the commit. A change that
moved Minecraft can only be rolled back with that world; one from an uploaded file cannot
be (the file is not kept), nor one whose server is no longer on the version it went to.

Downloads that come with a hash (mods, packs' files, data packs, loader jars, Fugue) are
recorded with it (`downloaded_files`, `filecache.ts`); a later download of the same content
copies one of those files instead of fetching it: a second server on the same pack, a copy's
pack change, a reinstall. Keyed on content only, never on a name or version label: packs ship
patched jars under upstream version numbers, which is why every mod used to be downloaded
fresh. A recorded file is hashed again before it is used and the copy hashed once more, so
one changed, replaced or moved since is never copied (its record goes), and a download
without a hash is always fetched. Copies are reflinks where the filesystem has them; no
symlinks, so servers never share a file. Test files in one worker share a database, so the
lookup is off in them except in `filecache.test.ts` (`tests/setup.ts`).

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

**The same mod twice** (`duplicateMods` in `crashdiag.ts`, Mods tab): enabled jars that
declare one mod id in their own metadata (fabric.mod.json, quilt.mod.json, mods.toml
`[[mods]]` blocks, mcmod.info), typically one copy from Modrinth and one from CurseForge
under other file names; platform metadata shares no id between the two. Forge, NeoForge and
Fabric refuse to start with an id present twice. Template ids unrelated mods keep
(`examplemod`, `modid`, ...) do not count, nor ids inside nested jars (libraries). Shown
above the Installed list (streamed: a big pack's jars take a while the first time) with a
Disable button per copy, and counted under "Needs attention".

**What needs a mod** (`requiredBy` in `crashdiag.ts`, Mods tab): for each jar, the enabled
mods that require an id it has (its own, Fabric/Quilt `provides`, or a mod nested in it)
when no other enabled jar has that id. Required means Fabric's `depends`, Quilt's
non-optional `depends`, a mods.toml dependency with `mandatory=true` or `type="required"`
that is not `side="CLIENT"`, and mcmod.info's `requiredMods` (1.12 mods mostly declare theirs
in `@Mod` instead, which is not read). Client-only dependents do not count: the loader skips
them. Streamed with the duplicates; the row says "Needed by ...", and the switch and Remove
ask before disabling or deleting such a mod (in the page only, as a question, not a refusal).

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
missing on the server that is not client-only was removed on purpose and stays out. With the
server list ticked (the default), a `servers.dat` in the game folder (`overrides/`, Prism's
`.minecraft/`) lists the server: uncompressed NBT `{servers: [{name, ip}]}`, the address
prefilled with playit.gg's when the server has a tunnel, else the LAN one. Files
are linked where the format can: Modrinth's CDN URL (found by the jar's sha512) in a
.mrpack, whose spec allows only cdn.modrinth.com, GitHub and GitLab hosts; project and file
id in a CurseForge manifest, which cannot say "disabled", so disabled mods are bundled as
`.disabled` files. Everything else is bundled in the overrides. Prism bundles everything;
its loader is `mmc-pack.json` components, and for Cleanroom the patches and components come
from the instance Cleanroom publishes with each release (0.5.x on). Modrinth and CurseForge
packs cannot name Cleanroom, so they ask for Forge 1.12.2 (the version migrated from, else
14.23.5.2860) and the page says so.

**Mod list export** (`modlist.ts`, the Export page's "Mod list") lists the mods in the
folder as text, like Prism Launcher's: the server sends the entries and the page formats
them (`lib/shared/modlist.ts`: Markdown, plain text, HTML, CSV, JSON), so changing the
format or fields needs no round trip; Copy or a download made in the browser. Name and
link come from the mod's record; version and authors from the jar's metadata (fabric.mod.json,
quilt.mod.json, mods.toml, mcmod.info, read by crashdiag's `indexMods`), falling back to the
record, since Modrinth's project has no author and CurseForge's "version" is the file's
display name. Jars without a record, or recorded as uploaded, are named by their metadata.
It needs only the view permission, like the Mods tab.

Update checks (`updatecheck.ts`, from the scheduler's tick, not awaited by it) look for the
next pack version on a pack server and the next loader build on a server without a pack;
a pack's author picks its loader, so pack servers are never offered one. Per server: on or
off, every 6 hours to weekly, and the least stable channel offered (releases by default).
A pack version is newer by its publish date (the provider's order where the mirror has no
dates); a loader build by its version number (the loaders' lists are not reliably in order:
Quilt's per-version list and Forge's maven metadata are not), its channel read from the name
(`-beta`, `-rc`, `-pre`). Forge names no betas: its recommended build (promotions) counts as
the release and anything newer as a beta, which its settings call "Latest builds too" and
notices "not yet recommended". Cleanroom names every build alpha and 0.6 broke mods
(CleanMix), so it is offered its own line only. The result is one `update_notices` row
holding the version it was found from: once the server runs something else, the notice is
not shown until the next check, so no install path has to clear it. A skipped version stays
hidden when found again; a newer one shows. The overview's button opens the server's
Settings with the version picked (`?packVersion=` / `?loaderVersion=`), where the pack
change previews at once: installing still goes through the normal review, snapshot choice
and Java prompt. A failed lookup is retried after an hour.

On a server without a pack the same check also looks for mod updates (`modUpdateCheck`,
"Include mods", on by default and in the new-server defaults): `checkModUpdates` without
the dependency resolution, which only matters when updating. A pack's mods change with the
pack (user's call), and the Mods tab still checks any server by hand. Enabled mods only (the
review starts disabled ones unticked). The result is one `mod_update_notices` row
(`modnotice.ts`) with each mod and its target and a fingerprint of that set: the same set
found again keeps its skipped flag and is notified once; applying updates
(`changeModVersions`) deletes the row. The overview's button opens the Mods tab at
`?view=updates`, which runs the check on arrival.

---

### Moving a server to another MineShell

`serverbundle.ts`, the server's Export page ("Move to another MineShell") and Add a server's
"Import from another MineShell". An export is one zip: `mineshell-export.json` (format
version, MineShell version, the server's loader and pack, its settings, its MineShell
records, the list of files to download again) and the server folder under `files/`.

Like a modpack, a mod MineShell can download again is listed instead of carried: a jar
Modrinth knows by its sha512 (one `version_files` call), or one whose row is a CurseForge
project and file id (resolved to a URL on import by `downloadPackFiles`, as pack files are).
Everything else is carried: unknown jars, configs, worlds and the rest. The loader is not:
the import installs the same version, so `isLoaderInstallEntry` entries stay out, and so do
`.fabric-cache/`, `versions/` and `.cache/quilt_loader/` (the vanilla jar Fabric's install caches,
what the vanilla server unpacks on first start, and Quilt's remapped game jars), `eula.txt`, `session.lock` and what a clone skips. Worlds are
in by default; snapshots, logs, a map mod's tiles and a backup mod's own backups (`backups/`,
`simplebackups/`: AromaBackup's zips were 21 GB on a 7 GB world) only when ticked (`bundleCategory`). A
running server's saving is paused (save-off, flush) while the zip is written and turned back on
however it ends. The zip is built into `$DATA/tmp/server-exports/<task>/`, refused when the disk
lacks room for it plus 1 GB, and kept an hour.

Settings travel through `checkedSettings`: a fixed list (memory, JVM flags, restarts, crash
restarts, boot start, resource limits, console, update checks, notes), each checked like a
settings page would; a failing value keeps the new-server default. Records travel the same way,
each through its module's own setter where it has one: mod rows (source, version, enabled,
locked, from pack, client-only), scheduled commands, macros, player fields, data pack sources,
snapshot policy and schedule, tags (by name, created if missing). What belongs to the machine
does not: ports (the import's own, or the next free), the RCON password, the Java path,
accounts' access (the importer becomes admin, as on any new server), playit tunnels,
notification destinations (they hold webhook URLs), run history.

Import: the file is uploaded raw to `PUT /api/imports` (exports run to gigabytes; form bodies
are buffered whole) or, for the owner only, read where it lies by its path (`POST`, left in
place). Reading every entry once, `readManifest` refuses a damaged zip, one with an entry
outside the folder (yauzl's own check), and a newer format. The staged file waits two hours
for the import action, which runs like any new server: journalled `create`, Java planned up
front (`JavaPrompt`), the loader installed, `files/` unpacked through `safeJoin`, the downloads
fetched (failures listed as missing, to fetch later), this machine's ports and RCON password
written into the export's server.properties, then settings and records.

## Worlds

Snapshots live inside the server folder, `.mineshell/snapshots/<id>/`, with the world
folders at their relative paths and a `manifest.json`; one is assembled as `<id>.partial`
and only counts once renamed. A copied snapshot also has `hashes.json` (each file's size,
modification time and SHA-256, apart from the manifest so listing stays cheap) and shares
every file an earlier snapshot holds unchanged as a hard link (`copyWorld`): a live file is
hashed only when some snapshot has a file of its size, linked to the newest snapshot holding
that hash while the target still has the recorded size and time (a file changed in place is
never shared further), otherwise copied (reflinks where the filesystem has them) and hashed
as copied. Snapshots without records (older, or made by moving the world) are copied from,
never linked to. This rests on two rules: a snapshot's files are never written to (manifests
are replaced by rename, the Files tab replaces files) and the live world never shares a file
with a snapshot (restore and "new world" copy out, world changes move the world in). Deleting
a snapshot, by MineShell or by hand, removes names; the file system frees a file with its last
name. Sizes on disk count each file once (`snapshotFiles`, by inode, cached per snapshot
folder): retention counts what a snapshot adds to the ones kept and pinned, Settings and the
World tab show the total, disk usage what each holds alone plus one line for what they share. Pinning, the user's name (`note`) and tags only rewrite the
manifest (`updateManifest`). Before MineShell's own risky operations the world is copied
into one (reflinks where the filesystem has them). The World tab's operations - reset,
replace, restore, reset or restore one dimension, restore chunks, prune chunks - instead move what they
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
"Snapshot now" on a running server takes the live path too (`snapshotWhileRunning`, same journal),
refused while the server is starting, stopping or about to restart.
Retention is the ordinary policy, so frequent scheduled snapshots push out older
pre-operation ones once over the limits (pin one to keep it). A server without a stored schedule has
none; a new one gets its schedule written at creation from New server defaults (built in:
daily at 04:00, skipped when nobody played), so existing servers keep none after an update.

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
A slot the disk has no room for (the snapshot would leave less than "keep free") is skipped
before anything is stopped. How the last due slot ended is kept (`snapshots.lastScheduled:<id>`,
shown under the schedule in Settings when it did not work); a failure, the 30-minute wait or
the disk skip is notified (kind `backup`) once per run of them, like the backup copies. The
idle skip and a slot skipped for another operation are not failures.

**Low disk space** (`diskspace.ts`, every scheduler tick): servers grouped by the disk they are
on (`stat().dev`); a disk below its line - the largest "keep free on the disk" of its servers,
where their snapshots stop, or 2 GB when all have it off - is notified once (kind `disk`),
under the first of its servers whose destinations take it, naming the others; again only
after it was 10% above the line. Kept in memory, so a restart while low says it once more.

**Backup copies** (`backups.ts`): snapshots copied to a backup folder off the server's disk.
The folders (destinations) are a `settings` row the owner edits under MineShell settings >
Snapshots; each server picks one, which snapshots (every full one, or scheduled and taken by
hand; partial ones never) and how many are kept there (`backups.server:<id>`), and the last
result is kept beside it (`backups.last:<id>`). A destination is a store with a few operations
(problem, free space, list, write, read, remove, rewrite a manifest); a folder is the only
kind, others would be more stores. On a folder, `<folder>/<server id>/<snapshot id>/` has the
snapshot's own shape, or, with the folder's "compressed" on (the default), `<snapshot id>.zip`
with the manifest beside it as `<snapshot id>.json`, so listing and retention never open a zip
(region files at deflate level 1: a third smaller, as small as level 6, faster). Either is
written as `.partial` and renamed when complete, a zip's manifest last, since that is what
makes it listed; both kinds are read, so the setting can change, and copy back lays the
manifest beside a zip over the one inside it. Leftover partials are removed before a sync
copies. The folder itself is
never created: an unmounted drive leaves an empty mount point on the system disk, which a copy
would fill. What a sync does is worked out from both sides each time (`planBackup`): the newest
`keep` of what is there and what should be, plus pinned ones (the server's pin while it has the
snapshot, the copy's after), are kept there; missing ones are copied, newest first, the rest
there deleted, and manifests whose pin, name or tags changed rewritten. So a copy cut short or
failed is made at the next sync, and nothing is copied only to be deleted. Syncs run one at a
time for all servers: 15 s after `snapshot:finished` (bus, from `finishSnapshot`; postponed
while the server has an operation, since a world change finishes its snapshot before it commits
and a rollback moves it back), for every server 2 minutes after MineShell starts, and every
hour for servers whose last one failed. A failure is recorded, audited and notified (kind
`backup`) once per run of failures; the snapshot itself is never failed by it. A copy back
(World tab) copies one into the server's snapshots as `.partial`, then renamed, checked against
the server's keep-free space; a global admin can copy back another server's copies (a server
deleted and made again), which then become a world of their own or restore if the world names
match.

Dimensions are found on disk (`dimensions.ts`): a folder holding `region/` or `entities/`.
The overworld is the level folder's own `region/`, `entities/` and `poi/`, so resetting it
keeps `level.dat` and player data. A snapshot of only some folders is marked `partial` and
restores only those.

1.12 mods' dimensions are folders with only a number (`DIM-11325`); `dimensionnames.ts` names
them on the World tab, Restore chunks and disk usage. Forge 1.12 and Cleanroom list every
dimension type with its ids (`forge dimensions`: the header, then "deep_dark: {-11325}" per
type, read from the command's bytecode), so a running server is asked once per run, in the
background (page loads never wait), and the answer kept (`dimensions.names:<id>`): "Deep Dark
(DIM-11325)". Until then a guess from Forge configs, shown as one ("DIM-11325 (Deep Dark?)"):
an integer entry equal to the number whose key says dimension, or an id key in a dimension
category, or the category alone (ExtraUtils2's `"dimension ids" { I:"Deep Dark"=-11325 }`),
in that order; keys about biomes, ores, counts and the like never (biome ids share the
numbers); a one-word name gets the mod in front. On MeatballCraft's 21 numbered dimensions it
named 16, Twilight Forest and Erebus among them; DIM20 is claimed by two mods' configs, which
only Forge's answer settles.

**Restoring chunks** (World > Restore chunks; `chunkrestore.ts`, `restoreChunks` in
`world.ts`): every region file holding a chosen chunk is rebuilt from the live file and the
snapshot's (`assembleRegion` in `regionfile.ts` copies chunks as stored, sectors and
timestamp, never decoded), in `region/`, `entities/` and `poi/` alike; a chosen chunk the
snapshot lacks goes and generates again; `.mcc` files of oversized chunks move with them.
It is a world change whose `moving`/`placing` are those files, planned from the headers
while the server is stopped. The replaced files are always kept as a partial snapshot (a
rename, a few MB; no question asked), which restores them. A region file the restore created
(the live world had none) is not in that snapshot, so restoring it leaves that file.

**The chunk map** (`chunkmap.ts`, `ChunkMap.svelte`, `lib/shared/chunkmap.ts`) is drawn in
the browser from two endpoints: the overview (every region header's chunk list, cheap for
a whole world) and one region's top block per column with height and water depth, full
(512x512) or, zoomed out, every eighth column (64x64, ~6 KB) for every region in view, so a
whole world fills in. Full pictures go to the 56 regions nearest the middle, 64 kept: more
in view than kept made them push each other out and reload, flickering. Reading is on the main thread, so regions are read one at a time
across all maps (`inTurn`) and yield after every chunk: a cold region takes ~0.5 s and other
pages stay at a few hundred ms meanwhile (two at once with coarse yields made them wait
15 s); cached ones answer in ms. Block
data is read in every format: 1.18+ `sections`, 1.13-1.17 `Level.Sections` (indices span
longs before 1.16, DataVersion 2527), 1.12 and older `Blocks`/`Add`/`Data` named through
Forge's registry in level.dat (`legacyBlockIds`) or vanilla's numbers, and
RoughlyEnoughIDs/JEID sections, whose `Palette` int array holds `id << 4 | meta` and whose
Blocks/Add/Data hold the index into it (`(add << 12) | (blocks << 4) | data`). Decoded
columns are cached per server and folder in `cache/chunkmap/` by file size and time.
Colours are the block's top face texture, averaged (`png.ts`) and tinted, through the item
icon index (`blockLook`: the blockstate's model, else the item's picture); 1.12 mod fluid blocks without a model by the
texture named after them (`fluidColour`: cwater -> cwater_still); Minecraft's own
blocks without its client jar (EULA unanswered; the page offers the same one-click answer
as item pictures) by a short table of rough colours (`VANILLA_COLOURS`); a block without
a texture is plain grey and the height shading still shows the land. LZ4 and damaged chunks
are drawn as grey squares; chunks with nothing to draw (from 1.18 a ring generated only partway,
status structure_starts, biomes and the like, surrounds everything loaded: a third of irithyll's
chunks) faintly, with their status in the tooltip, so a region keeps its placeholder's shape. Item pictures turned off means no colours.

**Roofs** (the Nether's, mod dimensions' with bedrock top and bottom) are found from the
heights, never by block or dimension: a region whose columns' first block is at one height for
at least 60% of them (not water: an ocean is flat too) gets a second pass (`chunkUnderRoof`):
down through solid blocks, whatever they are (MeatballCraft's Nether roof is often netherrack,
the Deep Dark's three layers of bedrock and stone under them, Arcana's one bedrock layer), to the
first open space, and the first block under it. A column solid to the bottom (a dungeon's wall)
shows the block under the roof. Kept only when a fifth of the columns have such a floor
(superflat is flat on top and solid below). The map shows that view under a roof, with a switch
to the roof's surface (`view=surface`: what is built on top). Open spaces of every size count:
ignoring ones under 4 blocks (pockets in the roof's mass) also hid the Nether fortresses'
corridors and changed little else, compared on MeatballCraft's Nether (2026-10-18). A dimension
other than the overworld opens on the region with the most chunks (`busiestRegion`): a mod's
can have two chunks near 0,0 and the rest kilometres away.

**Pruning** (`chunkprune.ts`, `PruneMap.svelte`, rules shared with the browser in
`lib/shared/chunkprune.ts`) starts with an analysis: a task reads every chunk's
InhabitedTime and size in one dimension (`analysePrunable`, read only, so also while the
server runs) and keeps it in memory, one per server; one runs at a time per server (reserved
before anything is awaited), and the page shows its task's progress by the button, from its own
data on the first paint and then from the task stream (the action answers with the task's id,
so a click does not wait for the page's data to reload). Reading yields after every chunk, as the
chunk map does, and takes only InhabitedTime out of each chunk (`peekNumber` in nbt.ts skips
everything else by its length instead of building the tree: ~9x faster, decompression is now
most of it); the terrain view reads its regions separately, as Restore chunks does; `/api/instances/[id]/prune-analysis`
sends it in binary (4 bytes of ticks and 2 of sectors a chunk). The page draws it through the
chunk map as a layer, a colour per chunk: the heatmap's steps (`--heat-1`..`7`), or, for the
chunks the threshold and spawn radius pick, the error colour, worked out in the browser on
every change. Chunks picked on the map are protected. The prune posts the analysis's time and
the protected list; `pruneChunks` refuses an analysis that is no longer the latest, and
removes a chunk only when the analysis showed it going, it is not protected, and on the copy
being pruned it is still under the threshold, so a chunk generated or visited after the
analysis stays. A finished prune drops the analysis.

**Planning a pre-generation** (World > Pre-generate; `PregenPlanner.svelte`,
`lib/shared/pregen.ts`) draws the area Chunky would cover on the chunk map, and a click
there moves its middle; the middle can also be typed, or taken from spawn (1.21.9+ names
the dimension it is in) or the dimension's world border (`worldBorder`: 1.21.11's
`data/world_border.dat` per dimension, before it level.dat's for the overworld only). Which
chunks are in follows Chunky's own rule (1.2 to 1.5 alike): the shape is put on chunks first,
its middle on the middle of the center's chunk and its radius to ceil(r / 16) chunks and a
half, then a chunk is in when its middle is inside (an ellipse by dx²/rx² + dz²/rz² ≤ 1). A
square of 500 is so chunks -32 to 32 (to block 527), which is what Chunky generated on a real
world; the map draws the outline along those chunks once they are big enough to see.
Chunky leaves a chunk only when its Status is full: the rings round everything loaded
(from 1.18) are on disk and partly have blocks but are finished like new ones. The chunk map
records which drawn chunks are not full (`partial`, beside the block-less `bare`) and dims
them on every map; the planner reads that for the regions the selection reaches (their
zoomed-out region data), three at a time, and counts only full chunks as done. The disk
estimate is the chunks to generate times what a full chunk took in the regions checked
(region file bytes; the overview carries each file's size). It works with the server stopped; starting needs it running. While Chunky
generates the dimension shown, the overview is read again every 20 s; the chunk map keeps
every region whose chunks and file size are unchanged and reads only the others again.

A snapshot names the world it was taken of (`world`, the `level-name` then; older manifests
are judged by their folders, `snapshotOfWorld`) and is restored only onto that world, which
a pack rollback's world restore also needs: after World folder changed, putting it back
would land beside the world the server loads.

**Several worlds** (`worlds.ts` finds them, the operations are in `world.ts`): a world is a
top-level folder with a level.dat, one MineShell made (maybe not generated yet) or the one
`level-name` names, which is the active one; `_nether`/`_the_end` siblings belong to their
world, the bisect world is none. Switching is a journalled `world-switch` that moves no
world: it records what the leaving world had in `.mineshell/worlds.json` (seed, level type
and generator settings, `pack_datapacks`, what the server ran, its map's render time),
writes the arriving world's back with `level-name` (an inactive world's size is measured
then, or when first listed, and kept until it is active again), and swaps BlueMap's `web/` with the
arriving world's kept one (`$DATA/maps/<id>/worlds/<folder>/web`) - the leaving map is kept
there or deleted. A crash puts the map and the properties back (`restoreWorldSwitch`, from
which moves are on disk). A world last saved by a newer Minecraft (level.dat's
`Data.Version.Name`, else the recorded run) needs `force`. New worlds come empty (generated
on the next start, the active world's data packs copied in unless unticked), from a full
snapshot, or from an uploaded zip (the world PUT with `?newWorld=`, unpacked beside the
others; `activate=1` only on a stopped server, checked again once unpacked). Pack changes
count every world folder as a world (never config, never written into), disk usage lists
the inactive ones apart, and deleting one puts its folders in the trash.

How many snapshots stay is a policy (`snapshots.ts`): the newest few full and partial ones
always, more while they fit a storage budget per server, set globally and overridable per
server. A copy that would leave the disk nearly full is refused.

The server is stopped for all of this; only downloading a running world does `save-off`,
`save-all flush` and `save-on`.

---

**Player stats.** `playerstats.ts` reads `<world>/stats/<uuid>.json` of the active world,
never writes it. 1.13+ nests categories; 1.12 and older are flat keys (`stat.mineBlock.minecraft.stone`,
`stat.walkOneCm`, `stat.killEntity.Husk`), mapped onto 1.13+'s categories and ids
(`playOneMinute` is `play_time`, in ticks) so units and names are shared
(`lib/shared/playerstats.ts`: ticks, centimetres, tenths of health). Names: vanilla general
stats from a built-in table, everything else from the server's lang files when item pictures
are on (the same jars), else the id tidied up. Parsed files are kept per path while size and
time stay the same. Counters are 32-bit and only ever added to, so a negative one wrapped
(1.12 counts any hit of 214.7 million health or more as the counter's maximum, so one hit
from a mod's instant kill does it): it is kept as NaN, shown as "overflowed", inherited by
totals over it and left out of the ranking, since how far it went is lost. The leaderboard ranks only players with a player file, as the player
list shows them: a stats file outlives a player file deleted to drop someone.

### The world map

`worldmap.ts`, the server's Map tab. For Minecraft 1.13 and newer MineShell runs BlueMap's
standalone CLI (downloaded from its GitHub releases into `$DATA/tools/bluemap/`, SHA-256
checked, on the newest installed Java 21+): it reads the region files and the server's mod
jars (`-n mods/`, for modded blocks' models and textures) and writes a static web map.
Everything per server is in `$DATA/maps/<id>/` - `config/` (written fresh before each
render: one map per dimension with a namespaced id, BlueMap's own web server off),
`data/` (caches and the Minecraft client jar BlueMap downloads, only with
`accept-download`, which follows the per-server EULA answer), `web/`. MineShell serves
`web/` itself under `/maps/<token>/view/` (sandboxed, below), the way BlueMap's server
would: a file, else its `.gz` with `Content-Encoding: gzip` (tiles and textures are stored
compressed), else 204 for tiles and live data. A render is a task (one per server; a running
server is told to `save-all` first) and only redraws what changed unless forced. An optional
schedule per server (off, every N hours, daily at a time; in the `map:<id>` settings row) is
checked on the scheduler's tick; slots missed while MineShell was down move forward.

Map mods: Forge/Cleanroom 1.12.2 is mapped by Dynmap with DynmapBlockScan (no standalone
renderer reads RoughlyEnoughIDs/JEID worlds; without BlockScan modded blocks are black), and
1.13+ can add the BlueMap mod for a live map. MineShell installs them (Dynmap's newest
1.12.2 build from CurseForge - on Forge's own the newest that loads there, `DYNMAP_NOT_ON_FORGE`, BlockScan from dynmap.us, BlueMap from Modrinth with the mods it requires, such as Fabric API on a server without a pack), gives each
server one port of its own for the mod's web server (`modPort`, from 8123, not another
server's), and writes it with a localhost-only bind into the mod's config before every start
(`applyMapModConfig`; BlueMap's config is created during install, so its first start uses
the assigned port and the per-server EULA answer; Dynmap's config is created by its first
start and is configured before later starts). `/maps/<token>/live/` passes requests
through to that port - bodies streamed, MineShell's own cookies and auth headers not passed
on, nor the map's cookies and its own CORS or CSP headers back. With the BlueMap mod in, the Map tab opens on its live map
(the one that is current); the rendered one is a switch away.

**The map's pages are not MineShell's** (`mapframe.ts`, `MapFrame.svelte`): BlueMap's web
app and a map mod's page run their own scripts, and players without an account put things
in them (Dynmap's chat, names some mods let players change, markers). So they never run on
MineShell's origin: everything under `/maps/` is sent with `Content-Security-Policy: sandbox
allow-scripts allow-forms allow-popups allow-downloads` (an opaque origin, also when the
address is opened on its own), CORS open (the apps' module scripts, fetches and WebGL
textures are CORS requests from that origin; a preflight is allowed whatever headers it asks
for, as Dynmap's jQuery adds X-Requested-With to every request), and no referrer. A sandboxed page sends no
SameSite=Lax cookie (only the frame's own navigation does), so its requests carry a token in
the path instead: `map_tokens` holds one per session and server (migration 0028), made by the
Map tab's load, gone with the session or the server or after 12 hours unused; each request
checks the session's account still has `view` (the live map's POSTs, Dynmap's web chat,
`map.render`). The guard lets `/maps/` through without a session and without the
cross-site check: the token is both, since another site cannot know it. A sandboxed page may
not use localStorage or cookies, which BlueMap and Dynmap do, so every HTML page there gets a
small script first (`withShim`) that keeps both in memory; the frame's `name` brings what
MineShell saved and the page posts every change back to the Map tab, which keeps it in its own
localStorage (`mineshell:map-storage`, started from the `bluemap-*` keys BlueMap kept when it
ran on MineShell's origin). "Open full screen" opens `/instances/<id>/map/full`, the same
frame with nothing around it (`+page@.svelte`, and the root layout leaves out the rail).
A BlueMap mod that came another way (a pack, added by hand) before the EULA was accepted
gets a panel asking only for that answer (`modEula`), without the render setup.

A BlueMap render's size is measured when the render ends and kept (`sizeBytes` in the `map:`
settings row; `mapDataSize` measures once for renders from before): walking 100k+ tiles took
seconds on every look at the Map tab. The disk usage breakdown (`diskusage.ts`) has a "World
map" group: map mods' folders (`bluemap/`, `dynmap/`) and that render, which is outside the
server folder (it links to the Map tab, not Files).

Simple Voice Chat (`voicechat.ts`) listens on a UDP port of its own (`port` in
`config/voicechat/voicechat-server.properties`, 24454 by default; `-1` is the game port's
number), which clients reach directly, not through the game connection. Two servers with the
default both want 24454 and the second stops itself at start, so `start()` refuses while a
running server with the same port, or anything else, holds it (a UDP bind test), and a copy or
a pack install gets a free port written into the config (from 24454 up, none another server's
or bound; before the mod's first start the file holds just that key, which the mod fills in).
The overview's firewall hint and the server's Network settings show the port.

All the servers' ports in one place (`portmap.ts`, MineShell settings > Ports, global
admins): game, RCON, query (the game port's number over UDP, when `enable-query` is on),
voice chat and the map mod's port, next to what listens on each now. Listening sockets come
from `/proc/net/{tcp,udp}[6]` (TCP in LISTEN, UDP bound and unconnected), their processes
from matching socket inodes in `/proc/<pid>/fd` (this account's processes only; others' show
without a process), and the server from the process's cgroup unit (`<prefix>@<id>.service`;
another MineShell's servers have another prefix and count as other programs). Rows show
clashes between servers (same number and protocol) and ports another program holds, with
"Free port" (the first one no server has and nothing holds, from where that kind starts)
and a typed number; a port following the game port (query, voice chat's `-1`) is changed
with it. Other programs are listed when they listen near the ranges ports are given from, or
are a server on a port it no longer has (changed, not restarted yet). New ports
(`allocatePort`) avoid every server's ports of every kind; before October 2026 only game and
RCON ports counted, so a stopped server's voice chat port could be given out again.
Where new ports start is a setting on the same tab (`portRanges`, a `settings` row): the
first game port (25565), RCON's distance above its game port (1000), and the first voice chat
(24454) and map mod (8123) ports; only new ports follow it. RCON falls back to the first game
port plus the distance when its own would land in 32768+ (Linux's outgoing-connection
ports, `EPHEMERAL`) and the starts do not (`rconStart`). The page leads with a warning that
the defaults suit almost everyone, and warns while a typed start is in 32768-60999.

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
A server with Simple Voice Chat gets a second, UDP tunnel (`tunnel_type` null) to its voice
chat port, `voiceTunnelId` in the same row (`syncVoiceTunnel`: made when it goes public and
before every start if missing, pointed at the current voice port, deleted once the mod is
gone): voice chat clients connect to it directly, not through the game's tunnel, and the mod
sends them to `voice_host`, which gets the tunnel's `host:port` address once playit has one
(at the latest on the next start). Going private deletes both and clears voice_host if it is
still the address MineShell wrote (`voiceHost`).
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

**Files trash** (`trash.ts`). The Files tab's Delete renames into `.mineshell/trash/<id>/<name>`
(copy and remove across filesystems), with `<id>.json` (original path, time, size) written
first: a crash between the two leaves a record without a folder, which listing drops. Ids
carry a random part, so two deletes in one millisecond stay apart. Restore renames back,
making missing parent folders, beside anything that took the place since ("name (restored)").
The trash itself, anything inside it and anything holding it (`.mineshell`) cannot move into
it and is deleted for good, as is everything when the kept days (`files.trashDays`, MineShell
settings, default 7) are 0. The scheduler's tick deletes items past the days; clones leave the
trash out, and disk usage shows it as its own group.
**Old logs** (`logretention.ts`). Minecraft archives latest.log into a new `logs/*.log.gz` each
start and removes none. With kept days set (`logs.keepDays`, MineShell settings, default 0 =
keep all), the scheduler deletes every server's archived logs and crash reports older than that,
reading each server's two folders at most once an hour; the current logs (latest.log,
debug.log) and anything else in `logs/` stay. The same deletion (`deleteOldLogs`) backs disk
usage's "Delete them", at 30 days.
Pack files are the uploader's: a `.mrpack` or file list naming a path that leaves the
server folder is refused when parsed (`packPath`), and `downloadPackFiles` writes through
`safeJoin` as well, since targets also come from CurseForge file names and the world mapping.

**Downloads.** `downloadFile` takes only http(s) and refuses a host that is, or resolves to,
a loopback, private, link-local, CGNAT (Tailscale), reserved or multicast address, checking
every redirect hop itself (`redirect: 'manual'`): a pack's URLs would otherwise let anyone
allowed to create a server make MineShell fetch from services only reachable from the host.
198.18.0.0/15 is not refused: proxies with fake-IP DNS answer every name from it.
The owner or a global admin can allow an exact address (`downloadaccess.ts`, settings row
`downloads.allowedAddresses`, endpoint `/api/downloads/allowed`): never a range, and never by
name, which could resolve elsewhere later. A refusal carries host, address and kind
(`BlockedDownloadError.blocked`) and is recorded three ways, each of which asks
(`AllowDownloadPrompt`): on the task it happened in (`Task.blocked`, through an
AsyncLocalStorage in tasks.ts; Activity), on a missing pack file (`MissingDownload.blocked`;
the overview's "Allow and try again" submits the list's retry), and in memory among the last 20
refusals (MineShell settings > System, beside the allowed list). The check resolves the name
before fetch resolves it again, so DNS rebinding is not covered; pinning the address would need
undici's Agent. Spark's upload URL (`bytebinUrl` in the server's Spark config) is not checked.

**Secrets.** RCON passwords (and a CurseForge key set in Settings) are AES-256-GCM
encrypted with a key in a `0600` file (`secret.key`) beside the database. Losing the key
means regenerating RCON passwords, which a server's Settings can do (Network, "Generate a
new password on save"). Settings sends a server's RCON password only when its Show button
asks for it (`?/revealRcon`): not with the page, and not in the property values or the raw
server.properties editor, which leaves the line out (a save puts it back from the database).

**Cross-site requests.** A state-changing request whose browser `Origin` names another host
is refused (`guard.ts`). Only the host is compared, against `Host` and `X-Forwarded-Host`,
because MineShell is reached by raw IP, other hostnames and through TLS-terminating proxies;
SvelteKit's own full-origin check is turned off for that reason. Every response also says only
MineShell may frame it (`X-Frame-Options: SAMEORIGIN`, and `frame-ancestors 'self'` where the
response has no policy of its own; `withSecurityHeaders`), since a page on another port of the
same machine would share its cookies.

**Auth.** Accounts (`users`) with scrypt-hashed passwords, session cookies, and a login
throttle per address (10 failures in 15 minutes) and per account name (50, high enough that
failing on purpose does not easily lock the owner out). The guard reads the session's account
on every request, so a deleted session or a disabled account stops at once. The owner, named
`admin`, is created by /setup, or by migration 0019 from the old single admin password (whose
sessions it kept); other accounts are added under MineShell settings > Accounts (`accounts.ts`).
A new account or a reset one gets a random one-time password, shown once and kept only as a
hash, and `must_change_password`: until it picks its own on `/account` (which asks for the
current one), the guard lets it reach only that page and signing out. Disabling or resetting
signs the account out everywhere. Who may change whom (`mayManage`): nobody changes the owner
there, only the owner a global admin (or makes one), any global admin everyone else. The owner is the row with `is_owner`, never a
name; the database's triggers refuse to delete, demote or disable it, and a unique index allows
one. `npm run reset-password` gives it a new password from the shell (DEPLOYMENT,
Troubleshooting); it forces a change too. What each account may do: Access, below. The original notes
left auth open, wondering whether LAN-only made it unnecessary; it is on by default because
"LAN-only" tends to stop being true — a guest device, an IoT box, a Tailscale exit node — and
this application can delete a world.
`MINESHELL_AUTH=off` disables it and says so plainly on the settings page. The cookie's
name carries a hash of the data folder: browsers keep cookies per host, not per port, so
two MineShells on one machine (production and `npm run dev`) otherwise signed each other out.

**Access.** Who may do what is checked before anything runs, in one place. `lib/shared/access.ts`
holds the model: per-server permissions (`view`, `power`, `console.read`, `console.command`,
`players.manage`, `players.data.view`/`edit` with a player scope of none, all or chosen UUIDs,
`mods`, `datapacks`, `software`, `settings.view`/`edit`, `files`, `backups.create`/`restore`/
`delete`, `world`, `map.render`, `duplicate`, `delete`), and `can()`, the one answer to "may this
account do X on this server". The owner and global admins may do everything; an instance admin
everything on its server (permissions added later included), stored as a flag on its
`instance_access` row, apart from the listed permissions, so taking admin away leaves them.
`lib/server/access.ts` loads an account's access per request (no cache, so a change applies on
the next request); with `MINESHELL_AUTH=off` every request may do everything.
`lib/server/access/policy.ts` names what each page load, form action and endpoint method needs,
with the server from `params.id` and the player from `params.uuid`; `guard.ts` applies it. A
route, action or method missing from the table is refused for everyone, the owner included, and
`policy.test.ts` fails on any that has no entry, so a new one cannot be reachable by accident.
Where the posted form decides (the ops list, unpinning a snapshot, a data pack or a mod, a
task's server), the entry is marked `handler(...)` and the handler calls `requireAccess`. A
refused page load redirects to `/denied`, never running its load (whose data would reach the
browser); a refused action answers as a failed action, an endpoint with 403. `files`, `mods` and
`software` can run a program on the machine as MineShell's user and so reach everything: they
are for people trusted that far.

Page data is cut to the account too, not only hidden on screen: the rail, the server list and
Activity (page and stream) hold only servers the account may see (tasks of no server, such as a
Java download, only for global admins); the overview's crash notice keeps its diagnosis (MineShell's
own words and the blamed mod) but its log lines, and each diagnosis's `evidence` line, need
`console.read`, and Forge's startup question comes in full (its console text, the missing
entries) only with `software`, the others learning just that it asks; Spark's profile links need
`console.command`; Players' IP bans need `players.manage`; a server's scheduled commands need console access; the playit.gg account links,
link-up and routing, and tunnels made outside MineShell are the owner's (global admins see the
status). A server the account may not see is "Another server" in port messages, and moving
another server's port to make room needs `settings.edit` on it. Two server.properties settings
reach past `settings.edit`, so both editors check them: the `management-server-*` keys
(Minecraft 1.21.9+'s management API, which can make players operators) need `software` to
change, and its secret is left out of the page without it (a save puts it back); a changed
`level-name` must stay inside the server folder (`cleanWorldPath`), since the game follows it
anywhere, another server's world included. A visitor who is not signed in
has no access (`NO_ACCESS`), never the full access `MINESHELL_AUTH=off` gives.

Pages show only what the account may use, from the same `can()`: the root layout hands every
page `access` (the account's own permissions, nothing secret), and tabs, header actions, buttons
and links are left out without the permission. Lists an account may look at but not change
(installed mods, a player's data, the whitelist switch) stay, disabled; a server's Settings
sections it may not change get `editable={false}` (`SettingsSection`: a disabled fieldset, "view
only"). This is for the eye only: the route policy and handlers decide.

Event streams (console, live stats, Activity) stay open, so the guard's check at the start is not
enough: `guardStream` checks the session and the permission again on every `access:changed` the
bus carries (published by sign-outs, disabling, resets, flags and grants) and every 15 s (an
expired session, a reset from the shell), and closes the stream once it fails; Activity's stream
also re-reads which tasks to show. The browser's EventSource gives up when its reconnect is
refused, and `whenClosedForGood` then reloads the page's data, so the guard moves the page to
sign-in or "No access" within seconds.

The audit log (`audit_log`, MineShell settings > Log) records which account did what:
hooks.server.ts runs each request with `runAs` (`requestcontext.ts`, Node's AsyncLocalStorage),
and `audit()` reads the account from there, so an entry written deep in an operation, or in a
task the request started that finishes minutes later, still names who asked. The account's name
is kept beside its id, so entries read right after it is renamed or deleted. MineShell's own work
(scheduler, recovery, boot) runs outside any request and has none; `actor` says what it was.

Access is given on an account's page under Accounts: per server "No access", chosen permissions
(grouped, the full-trust ones marked, player data as nobody's, every player's or chosen
players' with a picker of the server's known players), or admin of the server. Choosing admin
keeps the chosen permissions stored, so choosing them again later gives back the same. A
server's admin, "May add servers" (its adder becomes admin of it) and MineShell admin are
marked full trust as well.

Whoever adds a server, or copies one (which needs `duplicate` and `files` on the source and
"may create servers"), becomes admin of the new one: `insertInstanceRow` and `cloneInstance`
take a `creatorId` (`access.ts` `creatorId`: any account but the owner, global admins included,
so the server stays theirs if that role goes). The grant is made with the row, so a server whose
creation is rolled back takes it along. A copy takes the source's access list only when "Give the
same people the same access" is ticked, which only global admins see and may send (`copyGrants`,
before the creator is made admin).

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
commands, copy and delete) keep their own buttons; the ones with state of their own are
components beside the page (`IconSection.svelte` and friends), while the sections in the
save bar stay in the page, which holds their shared field state. Their row layout lives in
`SettingsSection` as `:global(.settings-section ...)` rules. The tab bar and search stick
under the server's header on desktop (`--instance-head`, the header's measured height, set by
the instance layout). MineShell settings' New server defaults uses the same sections and rows
(every section shown, through `provideSettingsView`) and `SaveBar.svelte`: one form, one
action, the changed sections named in the bar. MineShell settings' other tabs keep a form per
section on its own action, with no Save buttons of their own: each joins one bar through
`SaveTracker` (`lib/shared/savebar.svelte.ts`, `use:tracker.track={'Section'}`). There a form is
changed while what it would post differs from what it posted when last saved, so a button
that changes fields (Back to the defaults) counts too; saving posts the changed forms in page
order and reloads the page's data only when all went through, so a refused one keeps its
edits; Enter saves through the bar, and buttons with their own `formaction` (Send a test
message) still post at once. Leaving the tab with changes asks first. The row rules
(`.settings-section .rows ...`) are in app.css, so a page outside SettingsSection opts in
with the class. JVM flag presets are shared by every
server, so they live in MineShell settings (Java): a server's "Save current flags as a
preset" posts to `/settings?/savePreset`, and only MineShell settings edits or deletes one.
A saved preset's id is made from its first name and kept through renames (the defaults for
new servers refer to it); saving under an existing name replaces that preset.
A preset's flags can depend on the server's Java (`presetFlags`, `minJava`): ZGC needs 15+,
and `-XX:+ZGenerational` goes in only on 21-23 (17 refuses to start with it, 24+ warns that
it is ignored). Applying refuses a preset the server's Java cannot run; a new server whose
Java cannot run the default preset gets Aikar.
Saving JVM flags (`launch`) first runs the server's Java with them and `-version`
(`checkJvmFlags`: split at whitespace as the unit's shell does, the maximum heap kept since
G1 tuning can refuse a small heap, `-Xms` and AlwaysPreTouch left out) and refuses with
Java's own error; warnings ride along in the saved message. Saving a preset checks it against
one runtime per installed Java version and names the ones that refuse it, but saves anyway.
Java & memory saves through two actions: `memory` (heap sizes; it rebuilds `-Xms`/`-Xmx` in
the stored JVM arguments) and `launch` (Java binary, JVM flags, launch arguments). Those three
can run any program on the machine, so nothing that only changes memory may change them. The
memory fields sit between the launch form's sections and join their own empty form by its id.

**The Mods page**'s Updates and Add mods sub-tabs and the bisect panel are components beside
the page that stay mounted while another sub-tab is open (an `active` prop hides their
markup), so an update check, search results and the bisect form's picks outlive switching
tabs, as they did when it was all page state. The search box in the tool row drives the
browser through `bind:term` and its exported `search()`.

**The instance header** carries start, stop, restart and the delayed variants on every
tab. Its forms post to the overview's actions; an enhanced form posting to another page
would navigate there, so the header applies the result itself and reloads in place.
While the server is starting or stopping (the status pill's busy states) it reloads every
3 s until it settles, so a tab that depends on it (Pre-generate needs it running, Prune
chunks stopped) follows without being left.
The server list's cards do the same (start, stop, restart, pin, tags): every operation on
one server is an action under `/instances/<id>`, never an id in a form body, so the address
alone says which server a request touches.
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
and, for the ones that can stop, Cancel, tasks finished in the last half hour (the server keeps them that long),
an unread count kept per browser. A task that finishes while the panel is closed becomes a
toast, and any finish reloads the page data. What counts as finished since the page loaded is
measured against the layout data's `finishedTasks`, not the stream's first payload: a
snapshot of a small world can start and finish before the stream connects (`taskwatch.ts`). Toasts (`lib/shared/toasts.svelte.ts`) are also where
results go that have no place on the page, like a save in the player editor: closable,
and anything but an error closes itself after 8 s. The Activity page keeps the logs.

**Cancelling** is cooperative: work checks `task.isCancelled()` and stops. A task offers
Cancel only when it was started with `cancel` (what cancelling does, said back to whoever
cancels): pack downloads (installs, pack changes and the missing-files retry stop after
the files under way, and the rest are listed as missing, as failed downloads are; before,
they were forgotten and a retry counted them as done), the map render, a Spark profile, the
prune analysis. Everything else runs to the end: most operations cannot stop halfway.

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

Three shared controls stand in for plain form inputs. A setting that is on or off is a switch:
a checkbox with `class="switch" role="switch"` (or a button with `aria-checked` where clicking
posts at once, as on Mods and Players), styled in app.css; a checkbox for a one-off choice
made before an action ("also delete every file", "snapshot first") stays a checkbox. A short
choice of two to four options is a row of buttons, `SegmentedChoice.svelte` (radios in labels,
so forms post it as before); longer lists and long labels stay selects or radio lists. The
long version lists (Minecraft versions, loader builds, a pack's and a mod's versions) are `VersionPicker.svelte`: the browser
draws a select's popup and a page cannot set its height (Firefox's reaches the top of the
screen). It is a combobox: typing filters (`lib/shared/versionpicker.ts`: versions starting
with the text first), the list scrolls within a limited height, fixed to the window like
RowMenu's so a box's overflow does not cut it, releases apart from betas and snapshots when
a list has both (by the version, or by the platform's channel for a pack's or mod's version id), and a hidden input posts the value under the select's old name. It shows
whole lists, where the selects had cut them at 40 or 60 builds.

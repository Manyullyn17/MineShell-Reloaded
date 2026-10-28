# Running servers: systemd, journal, console, tools

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Runtime features (overview, scheduler)
- Dev: `boot()` is guarded on globalThis, so the scheduler's interval keeps running the code
  it started with. Changes to scheduler.ts/scheduledcommands.ts need a dev server restart.
- Countdown stops/restarts (`countdown.ts`) are in memory; nobody online = act at once.
- Clock changes (2026-10-28): daily times are built from each day's date (`dailySlot`), never by
  moving the last run a day on (a 02:30 the spring change turned into 03:30 stayed 03:30 the
  next day); "every N minutes" walks real minutes as the clock shows them (counting from
  midnight put a slot in the repeated autumn hour before now, and the command ran at every
  check). Tested under `TZ=Europe/Vienna`, set inside the test.
- Paused (empty), built 2026-10-18: 1.21.2+ logs only "Server empty for N seconds, pausing";
  nothing marks the wake-up, so a join clears `server_runs.paused_at` (history.ts). The game
  still reports 20 TPS while paused. Tried live on vanilla 1.21.11 (throwaway setup).
- Update checks (`updatecheck.ts`, built 2026-10-15): pack servers get pack versions, servers
  without a pack get loader builds (user's call). Tried live against Modrinth and Fabric meta
  on a throwaway dev server (seeded rows): Cobblemon 1.8.1 -> 1.8.2 offered and previewed from
  the overview's link, Fabric 0.19.4 -> 0.20.0.
  Loader builds are compared by number, never by list position: Quilt's per-version list and
  Forge's maven metadata are out of order (Forge 1.12.2: 2864-2861, then 14.23.0.2486...).
  Forge's recommended build (promotions_slim.json) is the release channel, newer ones beta.
- TPS (`tps.ts`): `forge tps` / `neoforge tps` / vanilla `tick query` (1.20.3+); formats from
  the loaders' lang files. Spark answers async, after RCON returns, so it is not used.
  Per dimension (2026-10-28): Forge 1.12 sends "Dim  0 (overworld) : ..." and runs the lines
  together over RCON ("...Mean TPS: 20.000Overall : ..."); only loaded dimensions are listed,
  so a fresh 1.12 server shows the overworld alone until someone visits the others. Forge
  1.16+ sends "Dim <level> (<dimension type>): ...". NeoForge 21.1 sends each level's
  description, translated on the server ("The Nether: 20.000 TPS (...)"), not its id.
- Stuck starting: >10 min without `Done (`; checked with `journalctl -g` on the run's
  invocation (`runFinishedStarting`), never the last-N lines (a days-old run's Done scrolls out).
- Crashed but still running: a process can hang on after "Encountered an unexpected exception"
  (MeatballCraft on Cleanroom 0.5.2: Tombstone's server-stopping handler threw). history.ts
  records the crash line (`crash_logged_at`); a minute later with the process up the overview
  shows the crash (`hungAfterCrash`), and the Stop that ends it does not hide it.
- Resource limits: `limits.conf` drop-in (MemoryMax/CPUQuota); user units need the memory and
  cpu controllers delegated (default). Limit floor heap + 10% + 1 GB (`minMemoryLimitMb`):
  MeatballCraft has 1.5-3.3 GB outside its 16 GB heap, and its Dynmap full render leaks
  native memory (~400 MB/min, measured 2026-10-15). A kill at the limit is diagnosed
  (`memory-killed`).
  Starting by hand warns when the machine may not have the memory (`memoryguard.ts`, "Start
  anyway?" posts again with `force`); new-server defaults can set an automatic limit.
  Cap on all servers (`servercap.ts`, 2026-10-16): `MemoryHigh`/`CPUQuota` in
  `app-<prefix>.slice`, the slice systemd 255 already puts template instances in (the
  template now names it); `-` in the prefix is `\x2d` there, kept literally in unit files.
- Exit codes: RCON/in-game `stop` -> 0; systemd stop/restart (SIGTERM) -> 143, which the
  template's SuccessExitStatus=143 counts as success (only an asked-for stop sends SIGTERM);
  startup crashes mostly 1, sometimes 0 (hence "never reached Done" = crash). The template is
  rewritten at boot when an older MineShell-written one is installed (`refreshTemplateUnit`).
- An RCON stop waits up to 5 min for the JVM to exit (`awaitStop`) before systemctl stop; it
  used to fire after a fixed 20 s, mid-save on big packs, and could stop a run started again.
- `pkill -f` in a shell whose own command line contains the pattern kills that shell.

## Java heap (memory advice)
- `heap.ts` reads heap use over the JVM attach socket (what jcmd does): `.attach_pid<pid>` in
  the cwd + SIGQUIT, then `/proc/<pid>/root/tmp/.java_pid<pid>` (PrivateTmp; on this machine
  user units' PrivateTmp is not actually applied). Protocol "1\0jcmd\0<cmd>\0\0\0", answer
  starts "0\n". `PerfCounter.print` is jcmd-side, not a JVM command; `GC.heap_info` works on
  Java 8 (8u backport) to 25. Tried on throwaway JVMs (8 G1/Parallel, 17 G1, 21 ZGC/Shenandoah/
  Parallel, 25 G1): nothing logged, trigger removed. All four real servers use
  -XX:+PerfDisableSharedMem, so the hsperfdata file is not an option.
- An unhandled SIGQUIT kills: never with -Xrs/-XX:+ReduceSignalUsage/DisableAttachMechanism,
  under a minute old, or twice to one that did not answer.
- Advice "less" only from hours with players online (`playedIntervals`): the user's point,
  an idle 2 GB of 10 says nothing when players take it to 8. Needs 5 hours of minutes
  actually played on 3 days (user's call, 2026-10-15; clock hours with 20 minutes of play
  let ~1h40m on two days through). Samples kept 14 days for it. "Short" still counts idle hours.

## Journal
- `journalctl -u <unit> -n N` walks matches slowly (~0.2 ms/line: 4 s for 20000). Anything
  polled must not do that: `readLastRun` reads the newest entry, caches by its cursor, and
  otherwise reads one run by invocation id (`_SYSTEMD_INVOCATION_ID` on the service's lines,
  `USER_INVOCATION_ID`/`INVOCATION_ID` on the manager's). `InvocationID` from `systemctl show`
  is empty once the unit is inactive.
- `listRuns`/`readRun` (Logs tab) keep what they read and continue with `--after-cursor`;
  `--show-cursor` puts the last entry's cursor at the end of `-o cat` output.
- The journal outlives an instance; a recreated server with the same id shares it, so reads
  pass `--since` the instance's `createdAt`.

## Server history
- `history.ts` reads journals every 30 s from `history_cursor` (newest entry, read first),
  filtered by `journalctl -g`; runs and player sessions in the database. Join/leave from
  `playerEventWithName`. Backfilled the throwaway vanilla server's two old runs (5 s, 7 s);
  joins only tested with faked journal lines (no client here).

## Servers after a reboot
- `bootstart.ts`, run from `boot()` after recovery; only a new boot (kernel boot id + PID 1's
  start time) starts anything. The kernel's id alone missed container restarts: a container
  sees the host's boot id (found 2026-10-25 in a Debian 12 Docker container with systemd;
  restarting it brought MineShell back but no server; with PID 1's start time it did). Tried for real on the throwaway setup (old boot id stored, vanilla server
  started through `mstest@` and reached Done; a MineShell restart on the same boot started
  nothing). Needs MineShell itself started at boot; the user runs `npm run dev`, so the
  settings show the "not a systemd service" note (`INVOCATION_ID` unset).
- `enableUnit`/`isUnitEnabled` in systemd.ts stay unused on purpose (ARCHITECTURE says why).

## Console view
- Line handling is `lib/shared/consolelines.ts`. Lines without a "[time] [thread/LEVEL]"
  prefix take the previous line's level (multi-line messages like Fabric's mod list) unless
  they are systemd's own lines; frames, "Caused by" and an exception line after an
  error/warning fold into that entry. Modern Forge prints ANSI colour codes; they are stripped.
- The server logs every RCON connection twice; MineShell used to open one per command
  (several a minute), so those lines are hidden by default. Now one connection per server
  (`rcon.ts`): Minecraft (1.12.2 and 1.21.11 read with javap) never drops an idle RCON
  client (read timeout 0), closes the connection unless a read holds exactly one packet (so
  never two in flight), and splits answers every 4096 characters - an end marker (unknown
  request type, answered "Unknown request") is sent once a full-size piece arrives.

## Crash diagnosis
- `crashdiag.ts` (node built-ins only) indexes mods/ from zip central directories and reads
  the last run's console. Culprit from loader attribution lines, then stack frames, then
  Mixin handler names (`handler$zza000$<modid, 12 chars>$...`). Errors before the loader's
  fatal marker are listed as non-fatal.
- Most loaders exit 0 after a startup crash, so "stopped without MineShell asking and never
  reached `Done (`" counts as a crash.
- `tests/crashdiag/` holds 30 recorded crashes across every loader and old/new versions, with
  `capture.mjs` to turn a new crash into a case.
- The watchdog (checked 2026-10-28 on vanilla 1.21.11 and 1.12.2 via `mc-probe.mjs` with
  `max-tick-time=1` and `save-all flush`): "A single server tick took N seconds (should be max
  0.05)", where 0.05 is the normal tick, not the limit (read server.properties for that), then
  "This crash report has been saved to: <path>" (1.12 with `/./` in it) and exit 1. The log has
  no stack; the report's "Description: Watching Server" block does (1.21: `java.lang.Error:
  Watchdog`, 1.12: `java.lang.Error`), with `app//` and `java.base@21/` frame prefixes. It first
  checks after the first tick following `Done (`, so a limit of 1 ms trips at once.

## Spark
- Spark runs commands on its own worker thread: RCON returns before Spark answers, and
  replies meant only for the sender (`spark tps`, "already running") are lost. Broadcasts
  ("Profiler is now running!", the upload link) go to the console too, so they are in the
  journal. Every upload (or save to disk) is recorded in `config/spark/activity.json`,
  newest first, 60 days; that file is how `spark.ts` knows a profile finished.
- Spark gives its upload 10 s, then saves the profile (raw protobuf) as `./config/spark/<name>.sparkprofile`
  and records `{type: "file"}` (irithyll, 2026-10-11: `spark-usercontent.lucko.me` answered 502).
  `uploadSavedProfile` repeats Spark's upload (`<bytebinUrl>post`, gzipped, `application/x-spark-sampler`,
  key in `Location`, link = viewerUrl + key; both URLs from Spark's config.json) and keeps the link
  in `.mineshell/spark-uploads.json`: activity.json is Spark's, rewritten from memory.
- Use the flag forms (`spark profiler --timeout N`, `--stop`, `--cancel`): Spark 1.5.2 for
  Forge 1.12.2 (MeatballCraft has it) knows only those; current Spark takes both.
- Live-tested with Spark 1.10.53 on Fabric 1.20.1, uploads sent to a local stub via
  `bytebinUrl` in `config/spark/config.json` (1.5.2 has the URL hard-coded). The 1.12.2
  path is checked against the jar's strings only.

## Chunky
- Answers synchronously, so RCON gets the reply (unlike Spark). Replies are in Chunky's
  language (`config/chunky/config.json` "language", default en): live progress is parsed
  from `chunky progress` in English only; the pause-for-players loop runs only in English.
- `config/chunky/tasks/<namespace>/<path>.properties` (one folder per namespace, read
  recursively) is written when a task stops and at shutdown, never while it runs. A finished
  task is saved as `cancelled=true`; unfinished = not cancelled.
- `chunky cancel` and starting over an unfinished task both wait for `chunky confirm`;
  pending actions are keyed by sender name, so a later RCON connection can confirm. The
  confirm prompt contains the literal "chunky confirm" in every language.
- Versions (jars of 1.2.54 to 1.5.3 compared, 2026-10-20): 1.2.x (Minecraft 1.16 to 1.19.2)
  keeps language, `continueOnRestart` and the tasks (keyed by world: cancelled, radius,
  radiusZ, centerX/Z, shape, count, time) in one `config/chunky.json`; 1.3 on has
  `config/chunky/config.json` and the `.properties` files (`center-x`, `radius-z`). 1.2.54
  (Fabric 1.16) has no `chunky progress`. Every version skips chunks that exist (unless 1.3's
  `forceLoadExistingChunks`), takes `start <world> <shape> <x> <z> <radius> [radiusZ]`, and
  has `spawn` and `worldborder`. `continueOnRestart` is off by default; MineShell turns it
  on (World > Pre-generate can turn it off) by writing it into an existing config before
  every start and restart (`applyChunkyConfig`), since Chunky reads it only at startup and
  1.2 writes its in-memory copy back whenever it saves a task. A missing config is not made:
  older versions may not fill in fields it lacks.
- Live-tested with Chunky 1.3.146 on Fabric 1.20.1 (start, progress, pause, continue,
  confirm, cancel); pausing for players only in tests.

## Notifications
- `notifications.ts` (built 2026-10-15): Discord webhook, ntfy, JSON webhook; MineShell's
  destination plus per-server ones. The event bus never carried crashes: events come from
  history.ts, the scheduler and updatecheck.ts. Tried end to end against ntfy.sh (random
  topic, read back with `/json?poll=1`): crash with cause, memory kill folded, stuck after
  10 min. A real Discord channel took the test message 2026-10-26 (the user's own server);
  every kind goes through the same `request()`, so that covers the Discord side.

## playit.gg
- `playit.ts`: agent claimed `self-managed` (its key creates tunnels; checked on a free
  account); old `/tunnels/create` (v1 rejects every body), which answers
  `AgentVersionTooOld` until the agent program has connected once. Free: global region only
  (`RequiresPlayitPremium`), 4 ports and 2 agents (premium 16 and 10; the user, 2026-10-09 -
  an earlier note said one agent; `AgentDisabledOverLimit` is only in the agent's log). UDP
  tunnels are free; plain TCP and HTTPS tunnels are premium (minecraft-java is not plain TCP). The IPC socket must fit 108 bytes (`%t`, not `$DATA`). The run data lists a
  new tunnel late: existence is checked with `/tunnels/list`. `display_address` works on the
  default port; a new one can take minutes to resolve (a resolver that asked too early caches
  the miss). Live test: the throwaway dev server (unit `mstest-playit`), user's account.
- Agent routing (where the agent connects out) is free and separate from tunnel regions:
  `/agents/routing/set {agent_id, routing: {type: "Automatic"} | {type: "Pop", details}}`;
  `/agents/routing/get` returns only target IPs (the user's automatic = Germany's). playit.gg
  is a SPA answering 200 to any path, so dashboard links can't be checked by curl; the user
  confirmed `/account/agents` and `/account/agents/<id>` (2026-10-09).

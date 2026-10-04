# Roadmap

What is not built, why, and roughly what order it makes sense to build it in.

This is not a schedule. It is a record of decisions so that future-you does not have to
re-derive the reasoning, and does not accidentally build something in an order that makes
it harder.

---

## Deliberately not built

### World backups

Decided against in the design notes and still not implemented. The reasoning: most
modpacks already ship a backup mod, and a half-built backup system is worse than none
because it invites trust it has not earned.

The known gap: a pack without a backup mod has no safety net at all.

If this ever gets built, the thing to get right first is not the copying — it is the
question that copying raises. A world save is only consistent if the server has flushed
it, so a real implementation needs `save-off`, `save-all flush`, copy, `save-on`, with a
guarantee that `save-on` runs even if the copy fails. Everything else is scheduling and
retention policy.

Note there is already a *different* backup mechanism in the codebase: the mod folder is
snapshotted before an update so a failed update can be rolled back. That operates on the
mods directory only and has nothing to do with world saves. The two were conflated in the
original notes; they should stay separate.

Status: still a maybe. The narrower case is built: a world snapshot before MineShell's own
risky operations, and snapshots on request from the World tab (`snapshots.ts`, `world.ts`).
There the server is always stopped, so the consistency problem above does not arise. The
World tab's download of a running server's world does the save-off / save-all flush /
save-on dance, with save-on in a finally.

---

## Dependency order

Some of these unlock others. Rough ordering:

```
mod updates ──────────► duplicate detection across platforms
     │
     └────────────────► hash-based mod cache

notifications ────────► needs no new infrastructure, the event bus already exists

remote access ────────► depends on the auth model, which is now settled
```

Mod updates are the biggest unlock and the most involved. Everything else is largely
independent and can be done in any order.

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

- Downgrade/disabled-mod options: disabled mods are updated and stay disabled; nothing asks.
- Required dependencies are installed, but nothing checks `incompatible` ones or removes a
  dependency the new version no longer needs.

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

- **Spark + TPS layer.** `tps.ts` does not use Spark on purpose: Spark answers
  asynchronously, after RCON has already returned. Using Spark means reading its answer
  from the console or journal after sending the command. That is the core of this item, and
  the profiler flow below needs it too.
- **Spark profiler flow**: start/stop a profile from the UI and show the
  `spark.lucko.me` link it prints. Same async-answer problem.

### Agreed

- **Chunky integration**: pregeneration with progress, pause/resume, and a scheduler slot.
  Not started.
- **Console enhancements.** Exists: Up/Down command history (in memory, lost on reload)
  and colouring by log level (`Console.svelte`). Missing: level filters, search, collapsed
  stack traces, join/leave highlighting, macros, persistent history, autocomplete. The Logs
  tab (journal runs and `logs/`/`crash-reports/` files) has no search or filter either.
- **Ban UI, the rest.** The Players tab already edits the whitelist, ops and bans
  (`players.ts`). Missing: a reason when banning (it always writes "Banned by an
  operator."), IP bans (`banned-ips.json` is not read or written), and op levels.
- **Disk usage breakdown.** Only a total per server exists (`instanceDiskUsage`, cached for
  60 s). Missing: the world split by dimension, logs, snapshots, `old-configs/`,
  `.mineshell/` backups, and cleanup suggestions. Modded dimensions live in `DIM*` /
  `dimensions/` inside the world, not only in the `_nether`/`_the_end` siblings.
- **Default Java per major version.** Order: the instance's pinned Java (`java_path`,
  exists), then a global default for that major (new: a radio button per version on the
  Java page), then the current automatic pick, which must be deterministic. Also an
  instance label showing which Java it will use.

### Later

- **Three-way config diffs on pack update**: the old pack config, the user's edited copy
  (now moved to `old-configs/`) and the new pack config.
- **World tools**: dimension reset and chunk pruning. Reset, replace, restore and download
  of the whole world exist (`world.ts`).
- **Granular snapshot restore**: one dimension, or a region of one. Restore is whole
  snapshot only.
- **Scheduler hook**: run a script after a snapshot.

### Maybe someday

- **Notifications (Discord/webhook)**: see "Notifications" under Later.
- **Client pack export**: a pack players can import into their launcher. Different from
  "Instance export and import" below, which moves a server between machines.
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
- **Mod bisect assistant**: disable half, start, narrow down. It could build on the crash
  analyzer and the journalled mod toggles.
- **Update availability checks**: mods have one (`modupdates.ts`). Missing: a newer pack
  version, loader build, or Java update shown on the overview.
- **Log rotation and retention**: nothing deletes old `logs/` or `crash-reports/` today.
- **Server bundle export/import**: the same as "Instance export and import" under Later.

### Dropped

- Panel hardening (it is LAN-only; remote access stays the Tailscale route below), idle
  auto-stop (wake-on-connect needs too much machinery), a fuller audit log beyond the
  existing one, adopting an existing server.
- Full world backups: see "Deliberately not built" above.

---

## Later

### Notifications

A Discord webhook on crash loops and scheduled restarts. The event bus in `events.ts`
already emits everything needed, so this is a settings form, a fetch, and a subscriber.
Deliberately kept out of v1 to avoid designing a notification framework for one webhook.

Moved from near term to later in October 2026.

### Duplicate detection across platforms

The same mod installed from both Modrinth and CurseForge appears twice with different
filenames and no shared identifier. Detecting this needs jar inspection — reading
`fabric.mod.json` or `META-INF/mods.toml` for the real mod id — rather than trusting
platform metadata. Worth doing after mod updates, since both want the same jar-inspection
code.

### Hash-based mod caching

Check a content hash before downloading and copy from an existing instance if it matches.
Explicitly deferred: it is an optimisation, not a correctness fix, and it partially
reverses the deliberate decision to always download fresh. If it happens, it must key on
*content* hash, never on version label — the whole reason for downloading fresh is that
packs ship patched jars under upstream version numbers.

### Instance export and import

The original design specified a `.jcpack` bundle containing mod metadata, overrides,
configs and instance settings, for moving an instance between machines. Still a good idea,
still not built. Its natural moment is after mod updating, since both depend on the mod
metadata being trustworthy.

### Remote access

The auth question the notes left open is now settled: password plus session cookie, on by
default. That was the blocker for designing remote access, so it can proceed whenever it
is wanted. The recommendation in `docs/DEPLOYMENT.md` — Tailscale rather than a public
reverse proxy — is where this should land unless there is a specific reason otherwise.

### Data packs from the mod browser

Modrinth projects that only publish a data pack `.zip` (no loader `.jar` build) show up in
the mod browser but have no installable versions, because versions are listed for the
server's loader. Install those into `<level-name>/datapacks/` instead, tracked like a mod.

### Pack change preview: content in data-pack-loader folders

Folders like `config/paxi/datapacks`, `config/openloader`, `global_packs/` or `kubejs/`
are pack config folders, so a pack change moves them whole to `old-configs/` - including a
data pack the user added there. Correct by the configs policy, but easy to miss for a data
pack; the preview could point out non-pack files in those folders.

### Item icons in the player editor

Slots show item names, not pictures. Minecraft's textures are Mojang's, so MineShell cannot
ship them; they can come from the user's own machine instead. Mod jars in `mods/` carry their
textures (`assets/<mod>/textures/item/...`); vanilla ones are in the *client* jar, which
MineShell would download from Mojang for the server's version and keep locally (map renderers
like BlueMap do the same and ask the user to accept the EULA first). The work is mapping an item
id to a picture: flat items are one texture via their item model (`models/item/<id>.json`, or
`items/<id>.json` from 1.21.4), block items are 3D models needing a small isometric render,
and leather, potions or grass need tinting. Something decent for most items is reachable;
perfect for every model is not.

### Multi-instance port management

Ports are allocated automatically and conflicts are detected, but there is no view showing
what is bound where across all instances. Cosmetic until you are running enough servers to
lose track.

---

## Considered and rejected

**A versioned REST API.** No second consumer exists — no CLI, no bot, no mobile app. Form
actions and a few endpoints cover it. Revisit only if a second consumer actually appears,
not in anticipation of one.

**tmux for process management.** This was the original TUI design and it is the right
answer for a terminal application. It is the wrong answer here: systemd already provides
supervision, restart policies, resource accounting and log collection, and a web app has
no terminal to attach to. See `docs/ARCHITECTURE.md` for why the `ExecStart` line is shaped
the way it is.

**Long-term resource history.** 24 hours at 10-second resolution, no rollup. Anything
longer means downsampling, retention tiers and a lot of code to answer questions nobody
running a home server actually asks.

**CurseForge server packs as the install source.** Looked at in October 2026 with a working
key: the official API gives each pack file a `serverPackFileId`, the mirror does not. Of
12 popular packs sampled, the layouts were few (flat, wrapped in one folder, a zip inside
the zip, ServerStarter's `server-setup-config.yaml` with no mods at all), but the contents
are the author's own test server zipped up: logs, config backups (`bettercombatmod.cfg
bruh`), start scripts, installers, `libraries/`. Some versions have none, they can lag the
client pack, the jars carry no project ids, and they run to 1.2 GB (a pack change preview
would download all of it). The client mod list plus `clientonly.ts` stays the one install
path. If the author's curation is ever wanted, the cheap form is reading only the server
pack's file list (HTTP range requests on the zip's central directory, a few KB) and flagging
client-list mods missing from its `mods/` as client-only - not installing from it.

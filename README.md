# MineShell

A self-hosted web control panel for modded Minecraft servers on Linux.

MineShell creates server instances from Modrinth, CurseForge and FTB modpacks (or from a
bare mod loader), runs them as systemd services, and gives you a console, a
`server.properties` editor, mod management, player lists and a file browser in the browser.

It is built for one person running a handful of servers on their own machine. It is not
multi-tenant and does not try to be a hosting panel.

---

## Requirements

- Linux with systemd
- Node.js 22.12 or newer
- A Java runtime — which one depends on the Minecraft version (8 for old packs, 17, 21, 25
  for 26.x; Cleanroom 21 or 25). MineShell learns the requirement from Mojang's version
  data, finds installed runtimes and matches one to each instance, and can download Eclipse
  Temurin or Azul Zulu builds itself.
- `journalctl` (part of systemd) for console output

## Install

```sh
npm install
cp .env.example .env      # edit if you want a different data directory
npm run setup             # creates directories, installs the systemd template unit
npm run doctor            # checks the things that silently break a setup
```

If `doctor` mentions lingering, run it once so your servers keep going after you log out:

```sh
loginctl enable-linger $USER
```

## Run

Development:

```sh
npm run dev
```

Production:

```sh
npm run build
npm start                 # honours PORT and HOST from .env
```

Open the app, set an admin password on first visit, and add a server.

To have MineShell itself start at boot, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Tests:

```sh
npm test                  # the whole suite, about 30 seconds, offline
npm run test:watch        # re-runs affected tests on save
```

Tests never touch real data; see [tests/README.md](tests/README.md).

---

## What it does

**Instances.** Create from a modpack you browse in-app (Modrinth, CurseForge, FTB), from a
`.mrpack` or CurseForge zip you upload, or from just a loader and a Minecraft version
(vanilla, Fabric, Quilt, Forge, NeoForge, Cleanroom). Before a pack installs you see its
mods and can untick client-only ones. Each instance gets its own directory, port pair (the game
port can be picked), RCON password and systemd unit. Later you can change the pack version (picked from the
provider, or by uploading the new version's file - the way to update a pack installed from an upload; your config edits
are carried over or merged, and where you and the pack changed the same lines you get a side-by-side review) or the loader version,
move a server that is not from a pack to a newer Minecraft or another loader (1.20.1 Forge to 1.21.1 NeoForge: every mod
MineShell can look up moves to a build for it, the rest are disabled and listed first),
migrate a Forge 1.12.2 pack to Cleanroom (and back), or copy the whole server to try
something on the copy first. Those operations are journalled: a crash halfway through is
rolled back at the next start. A server installed from a pack takes the pack's icon as its
server icon (players see it in their server list); it can be changed in Settings. Long operations run in the background; the notification center in
the top bar shows their progress from any page and lists what finished.

**Running servers.** Start, stop, restart, force stop, or stop/restart after a countdown
with in-game warnings, from the header of every server tab. Stopping goes through RCON with `save-all` then `stop` and waits for
Java to exit, falling back to SIGTERM, so worlds are not cut off mid-write. Crash restarts
are handled by systemd with a configurable attempt limit; scheduled restarts and scheduled
console commands by MineShell, with an option to wait while players are online. Per-server
memory and CPU limits, and a warning when a server never finishes starting. After the
computer restarts, MineShell starts the servers that should come back, one at a time: per
server "if it was running before" (the default), always, or never.

**Overview.** Uptime and how long the last start took against the usual, players (with
how long each has been on, today's peak and a kick button), tick rate where the server reports it,
CPU and memory over the last hour, 6 hours or day, how much of the Java heap is really in
use, with advice when a server needs more memory (or has far more than it uses), disk use, the address to connect to. Recent crashes with their causes, and which cause keeps coming back. After a crash: the last output and a diagnosis naming the mod that caused
it, with a one-click disable. With Spark installed, timed profiles uploaded for viewing.

**Console and logs.** Live output streamed from the journal, commands sent over RCON.
Filter by level, search, stack traces folded under their error, players joining and leaving
marked, command history and saved commands. A chat view shows only what players say (and
`say` broadcasts), and a chat mode answers them with `say`. The Logs tab has earlier runs and the server's
own log files and crash reports, searchable all at once (archived logs included). Any log
can be analysed by mclo.gs as a second opinion (read there, not kept) or be shared there at a link
that MineShell can delete again.

**Settings.** One page per server, in tabs (general, gameplay, players, network,
performance, Java and memory, automation, snapshots, advanced), searchable, with one save
bar that says which changes need a restart and can restart for you. The common
`server.properties` keys are typed controls, everything else is preserved in an "other
keys" section, plus a raw editor. Nothing is silently dropped. Port fields say at once
whether a port is free; one another server has can be taken by swapping ports with it or
moving it to the next free one.

**Mods.** Search and install from Modrinth and CurseForge with dependency resolution,
upload jars by hand, enable and disable (which renames to `.jar.disabled`, the thing the
loader actually reads), delete, switch a mod to another version, and check for and apply
updates. Client-only mods are spotted and disabled after pack installs. Data pack releases
from the browser go into the world's `datapacks/` folder. Jars added outside MineShell are
detected and identified rather than ignored. When a pack crashes and the diagnosis cannot say why, a bisect
assistant finds the mod (or pair of mods) by starting the server with fewer and fewer of them,
on a throwaway world, and puts everything back afterwards. Export a client pack for players as a Modrinth
`.mrpack`, a CurseForge zip or a Prism Launcher instance, with the mods and folders you tick
(all of them by default) and, for a server installed from a pack, the pack's
client-side files the server never needed.

**World.** Snapshots before risky operations, on request and on a schedule (daily or every
few hours; a running server is copied with saving paused, or stopped for it and started
again), kept by count and by storage
per server. Reset, replace with an uploaded world, restore a snapshot or download as a zip;
reset or restore one dimension; prune chunks nobody really visited. With Chunky installed,
pre-generate terrain with live progress.

**Players.** Whitelist, operators (with levels) and bans (with reasons, and IP bans),
edited live over RCON when the server is up and directly in the JSON files when it is down.
Names resolve to UUIDs through Mojang. A player data editor changes inventories, effects
and other saved data of players who are offline, mod inventories included (backpacks,
Curios and Trinkets slots, grouped and named by slot); on 1.12 and older, enchantments are picked
by name from the world's own table, mod enchantments included.

**Map.** A 3D map of the world in the browser, rendered by BlueMap from the world files
for Minecraft 1.13 and newer - nothing is added to the server, modded blocks are drawn from
the mods' own models. Updated when you ask or on a schedule; shown behind MineShell's login.
Forge 1.12.2 servers get a live map from Dynmap and DynmapBlockScan, installed from the Map
tab; on 1.13+ the BlueMap mod can be added for a live map with players on it.

**Files.** Browse, upload (with the button, or by dropping files and whole folders on
the file list), download, rename, delete, and edit text files in place, all
confined to the instance directory. A disk usage page shows where the space goes. Every
other upload (a world zip, a pack file, mod jars, the server icon) takes a drop onto its own
section too.

**Java.** Runtimes are found on the system or downloaded, matched per server, with a
default per Java version when several are installed.

## What it does not do

Backups elsewhere (another disk, another machine, the cloud) are not implemented: every
snapshot, scheduled ones included, stays inside the server's folder on the same disk. See [docs/ROADMAP.md](docs/ROADMAP.md) for the reasoning and
the rest of the deferred list.

---

## Layout

```
migrations/          plain .sql files, applied at startup
scripts/             setup and doctor
src/lib/server/      everything that touches the system: systemd, RCON, journal,
                     mod providers, pack parsing, scheduling, monitoring, worlds
src/lib/shared/      code the browser uses too: formatting, console line handling, NBT
src/lib/components/  console, crash diagnosis, snapshot choice, forms shared by pages
src/routes/          pages and endpoints
tests/               test setup, helpers, flow tests, recorded HTTP and crash fixtures
docs/                architecture, deployment, roadmap
```

`docs/ARCHITECTURE.md` explains why each piece works the way it does, including the two
places this deviates from the original design notes.

## Configuration

Everything is environment variables; see `.env.example` for the annotated list. The ones
worth knowing:

| Variable | Default | Why you would change it |
| --- | --- | --- |
| `MINESHELL_DATA` | `~/.local/share/mineshell` | Put instances on a bigger disk |
| `MINESHELL_AUTH` | `on` | `off` only on a network you fully trust |
| `MINESHELL_UNIT_PREFIX` | `minecraft` | Units are `<prefix>@<id>.service`; change to run a second MineShell |
| `CURSEFORGE_API_KEY` | unset | Better CurseForge metadata; can also be set in Settings |
| `BODY_SIZE_LIMIT` | `Infinity` in `.env.example` | Production refuses uploads over 512 KB without it |

## Theming

Every colour is a CSS custom property in `src/app.css`. Adding a theme is one
`[data-theme='name']` block there and one entry in `src/lib/shared/themes.ts`; the picker
in the top bar updates itself. The default is Deep Slate, from the original design notes.

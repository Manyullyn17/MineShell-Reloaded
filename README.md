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
mods and can untick client-only ones. Each instance gets its own directory, port pair, RCON
password and systemd unit. Later you can change the pack version or the loader version,
migrate a Forge 1.12.2 pack to Cleanroom (and back), or copy the whole server to try
something on the copy first. Those operations are journalled: a crash halfway through is
rolled back at the next start.

**Running servers.** Start, stop, restart, force stop, or stop/restart after a countdown
with in-game warnings. Stopping goes through RCON with `save-all` then `stop` and waits for
Java to exit, falling back to SIGTERM, so worlds are not cut off mid-write. Crash restarts
are handled by systemd with a configurable attempt limit; scheduled restarts and scheduled
console commands by MineShell, with an option to wait while players are online. Per-server
memory and CPU limits, and a warning when a server never finishes starting.

**Overview.** Uptime, players, tick rate where the server reports it, 24 hours of CPU and
memory, disk use. After a crash: the last output and a diagnosis naming the mod that caused
it, with a one-click disable. With Spark installed, timed profiles uploaded for viewing.

**Console and logs.** Live output streamed from the journal, commands sent over RCON.
Filter by level, search, stack traces folded under their error, players joining and leaving
marked, command history and saved commands. The Logs tab has earlier runs and the server's
own log files and crash reports.

**Server settings.** The common `server.properties` keys as typed controls, everything else
preserved in an "other keys" section, plus a raw editor. Nothing is silently dropped.

**Mods.** Search and install from Modrinth and CurseForge with dependency resolution,
upload jars by hand, enable and disable (which renames to `.jar.disabled`, the thing the
loader actually reads), delete, switch a mod to another version, and check for and apply
updates. Client-only mods are spotted and disabled after pack installs. Data pack releases
from the browser go into the world's `datapacks/` folder. Jars added outside MineShell are
detected and identified rather than ignored.

**World.** Snapshots before risky operations and on request, kept by count and by storage
per server. Reset, replace with an uploaded world, restore a snapshot or download as a zip;
reset or restore one dimension; prune chunks nobody really visited. With Chunky installed,
pre-generate terrain with live progress.

**Players.** Whitelist, operators (with levels) and bans (with reasons, and IP bans),
edited live over RCON when the server is up and directly in the JSON files when it is down.
Names resolve to UUIDs through Mojang. A player data editor changes inventories, effects
and other saved data of players who are offline.

**Files.** Browse, upload, download, rename, delete, and edit text files in place, all
confined to the instance directory. A disk usage page shows where the space goes.

**Java.** Runtimes are found on the system or downloaded, matched per server, with a
default per Java version when several are installed.

## What it does not do

General world backups (scheduled copies of a running world) are deliberately not
implemented; the snapshots above are taken while the server is stopped, around MineShell's
own operations or on request. See [docs/ROADMAP.md](docs/ROADMAP.md) for the reasoning and
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

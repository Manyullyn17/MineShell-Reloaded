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
- Node.js 20.11 or newer
- A Java runtime — 21 for Minecraft 1.20.5 and newer, 17 for 1.18 to 1.20.4, 8 for old packs.
  MineShell finds installed runtimes and matches one to each instance, and can download
  Eclipse Temurin or Azul Zulu builds itself.
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
npm test                  # the whole suite, about 5 seconds, offline
npm run test:watch        # re-runs affected tests on save
```

Tests never touch real data; see [tests/README.md](tests/README.md).

---

## What it does

**Instances.** Create from a modpack you browse in-app, from a `.mrpack` or CurseForge
zip you upload, or from just a mod loader and a Minecraft version. Each instance gets its
own directory, port pair, RCON password and systemd unit.

**Running servers.** Start, stop and restart. Stopping goes through RCON with `save-all`
then `stop`, falling back to SIGTERM, so worlds are not cut off mid-write. Crash restarts
are handled by systemd with a configurable attempt limit. Scheduled restarts are handled
by MineShell, with in-game warnings and an option to wait while players are online.

**Console.** Live output streamed from the journal, commands sent over RCON. Command
history with the arrow keys.

**Server settings.** The common `server.properties` keys as typed controls, everything
else preserved in an "other keys" section, plus a raw editor. Nothing is silently dropped.

**Mods.** Search and install from Modrinth with optional dependency resolution, upload
jars by hand, enable and disable (which renames to `.jar.disabled`, the thing the loader
actually reads), delete. Jars added outside MineShell are detected and flagged rather than
ignored.

**Players.** Whitelist, operators and bans, edited live over RCON when the server is up
and directly in the JSON files when it is down. Names resolve to UUIDs through Mojang.

**Files.** Browse, upload, download, rename, delete, and edit text files in place, all
confined to the instance directory.

## What it does not do

World backups are deliberately not implemented — see
[docs/ROADMAP.md](docs/ROADMAP.md) for the reasoning and the rest of the deferred list.

---

## Layout

```
migrations/          plain .sql files, applied at startup
scripts/             setup and doctor
src/lib/server/      everything that touches the system: systemd, RCON, journal,
                     mod providers, pack parsing, scheduling, monitoring
src/lib/components/  console, sparkline, status pill, flash message
src/routes/          pages and endpoints
tests/               test setup, shared helpers, recorded crash fixtures
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
| `MINESHELL_SYSTEMD_SCOPE` | `user` | `system` if MineShell runs as a system service |
| `MINESHELL_AUTH` | `on` | `off` only on a network you fully trust |
| `CURSEFORGE_API_KEY` | unset | Better CurseForge coverage |

## Theming

Every colour is a CSS custom property in `src/app.css`. Adding a theme is one
`[data-theme='name']` block there and one entry in `src/lib/shared/themes.ts`; the picker
in the top bar updates itself. The default is Deep Slate, from the original design notes.

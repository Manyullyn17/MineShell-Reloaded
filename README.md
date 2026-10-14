# MineShell

**A self-hosted web control panel for modded Minecraft servers on Linux.**

MineShell brings modpack installation, server management, diagnostics, world administration, and player data editing into one web interface. It runs each Minecraft server as a systemd service, with per-server configuration, resource limits, snapshots, and automation.

Manage your own servers from a browser, or give friends access to specific servers and features through granular account permissions.

## Features

### Modpack & instance management

Install and maintain modded Minecraft servers without having to manage every step manually.

- **Multiple sources:** Browse Modrinth, CurseForge, and FTB, upload `.mrpack` or CurseForge archives, or create a server from a Minecraft version and loader.
- **Loader support:** Vanilla, Fabric, Quilt, Forge, NeoForge, and Cleanroom.
- **Pack updates:** Update to a different pack version, including packs originally installed from uploaded files. Configuration changes are preserved or merged, with side-by-side review when both you and the pack changed the same lines.
- **Rollback:** Revert the last pack change, restoring the previous configuration and optionally the world from its pre-update snapshot.
- **Minecraft and loader migrations:** Move eligible non-pack servers between Minecraft versions or loaders. Compatible mod builds are selected where available; unsupported mods are disabled and listed.
- **Forge 1.12.2 / Cleanroom migration:** Switch between Forge and Cleanroom, including handling the compatible Fugue version required by Cleanroom.
- **Safe experimentation:** Copy an entire server to test changes separately.
- **Installation recovery:** Failed downloads are reported with manual download links and retry options. Long-running operations report progress and recover interrupted changes after a MineShell restart.
- **Server icons:** Pack icons are used automatically and can be replaced in server settings.

### Server operations & monitoring

Control server lifecycles and monitor what is happening without leaving the browser.

- Start, stop, restart, and force-stop servers, including delayed shutdowns with in-game warnings.
- Perform graceful shutdowns using RCON to save the world before stopping Java, with signal-based fallbacks.
- Configure crash recovery, restart attempt limits, scheduled restarts, and scheduled console commands.
- Delay scheduled operations while players are online.
- Set per-server CPU and memory limits, and detect servers that never finish starting.
- Choose which servers start after a machine reboot: restore their previous state, always start, or never start automatically.
- Monitor uptime, startup duration, online players, player session times, daily player peaks, CPU and memory usage, disk consumption, and tick rate where available.
- Inspect Java heap usage and receive guidance when memory allocation seems insufficient or excessive.
- View server addresses and manage players directly from the overview.

### Console, logs & crash diagnostics

Find out what went wrong without manually digging through files and terminal output.

- Live console output streamed from the systemd journal, with commands sent through RCON.
- Filter log levels, search output, expand or collapse stack traces, and highlight player joins and departures.
- Command history, saved commands, and a dedicated chat view.
- Search previous server runs, server logs, and crash reports together, including archived logs.
- Analyze logs with mclo.gs for a second opinion, or share them through a link that MineShell can subsequently delete.
- Diagnose crashes and identify likely problematic mods, with one-click mod disabling where supported.
- Detect crashes where the Java process remains alive but the server has stopped functioning.
- Run timed Spark profiles and view uploaded results. If Spark's upload fails, download the saved profile or upload it again.
- **Mod bisect assistant:** When ordinary diagnosis cannot identify the cause, systematically test individual mods or pairs of mods using a throwaway world, then restore the original server configuration.

### Mod management & client exports

Manage server mods and prepare matching client installations from the same interface.

- Search Modrinth and CurseForge, resolve mod dependencies, install updates, or upload JARs manually.
- Enable, disable, delete, and change mod versions.
- Detect mods added outside MineShell and identify them rather than silently ignoring them.
- Detect and disable client-only mods after pack installation.
- Browse and install data pack releases directly into a world's `datapacks/` directory.
- Export client installations as Modrinth `.mrpack` files, CurseForge ZIP archives, or Prism Launcher instances.
- Choose which mods and folders to include in an export. For servers installed from modpacks, include the original pack's client-side files that were not needed on the server.

### World management & snapshots

Manage worlds, recover from mistakes, and automate routine maintenance.

- Create snapshots manually, on a schedule, or automatically before risky operations.
- Snapshot a running server with saving paused, or stop and restart it around the operation.
- Configure retention by snapshot count and storage usage. Pin, name, tag, and filter snapshots.
- Restore a snapshot, reset a world, replace it with an uploaded world, or download a world as a ZIP archive.
- Reset or restore individual dimensions.
- Prune chunks that have not actually been visited.
- Pre-generate terrain with Chunky and monitor its progress.
- Coordinate snapshots and scheduled restarts so they do not interfere with each other.

**Backup limitation:** Snapshots currently remain inside the server's own directory on the same disk. Off-site, cloud, and separate-disk backups are not implemented.

### Player management & inventory editing

Administer players and inspect their saved data, including inventories containing modded items.

- Manage whitelists, operators and operator levels, bans with reasons, and IP bans.
- Update player lists through RCON while the server is running, or edit the relevant JSON files while it is stopped.
- Resolve player names to UUIDs through Mojang and identify players in imported worlds using their current account names.
- Inspect offline player inventories, effects, and other saved data.
- Edit modded inventories, including backpacks and Curios or Trinkets equipment slots, with slots grouped and named where supported.
- Select enchantments by name from the world's own enchantment table, including modded enchantments on Minecraft 1.12 and older.
- Browse vanilla and modded items by name instead of having to type their identifiers.
- View item icons and 3D block models sourced from Minecraft and installed mod JARs.
- Render supported special models, including chests, shulker boxes, beds, banners, heads, shields, conduits, decorated pots, and additional model-based variants.
- Inspect item tooltips containing information such as enchantments, durability, energy, and item identifiers.

Item rendering can be disabled in MineShell settings, leaving names and data available without loading or drawing item models.

### World maps

Explore your worlds through an integrated browser-based map.

- **Minecraft 1.13 and newer:** BlueMap renders a 3D map directly from world files, including modded blocks using models from the installed mods.
- Update the map manually or on a schedule.
- View the map without adding a rendering mod to the Minecraft server. Add the BlueMap mod when a live map with player positions is desired.
- **Forge 1.12.2:** Install Dynmap and DynmapBlockScan through the Map tab for a live map.

### Networking & public access

Let players join from outside your local network without manually configuring port forwarding.

- Integrate a playit.gg account through an approval flow; MineShell does not receive your playit.gg password.
- Enable public access for individual servers.
- Automatically manage the tunnel agent and server tunnel, keeping the tunnel associated with the server's port.
- Display the public address in the server interface and remove the tunnel when the server is deleted.
- Access the agent's playit.gg page and choose its connection location where supported by the account plan.

### Settings, files & Java

Manage server configuration and files without needing direct shell access for routine tasks.

- Searchable, tabbed settings for general options, gameplay, players, networking, performance, Java and memory, automation, snapshots, and advanced configuration.
- Typed controls for common `server.properties` options, alongside an editor for additional keys and a raw configuration editor. Unrecognized properties are preserved.
- Port availability checks, with options to swap ports with another server or move to a free port.
- Browse, upload, download, rename, delete, and edit text files within an instance directory.
- Upload files and folders by dragging them into the file browser.
- Recover deleted files from a per-server trash, with configurable automatic cleanup.
- Open server directories in a file manager through SFTP links.
- Inspect disk usage, including world-map data stored outside the server directory.
- Discover installed Java runtimes or download Eclipse Temurin and Azul Zulu builds.
- Match Java versions to individual servers using Minecraft's version metadata, with configurable defaults when multiple runtimes are available.

### Multi-user access & permissions

Share MineShell with friends while controlling which servers and features each account can access.

- **Global administrators:** The owner and MineShell administrators can manage the entire application.
- **Per-server access:** Grant full administrative access to a server or assign individual permissions for operations such as starting and stopping, console access, mods, settings, files, and snapshots.
- **Player-data restrictions:** Limit access to all players or specific players.
- **Automatic ownership:** The account that creates or copies a server becomes its administrator. Access to copied servers is not automatically granted to everyone who could access the original.
- **Account management:** Create accounts, issue one-time passwords, require password replacement on first login, disable accounts, and sign them out everywhere.
- **Permission-aware interface:** Accounts see only their permitted servers, tabs, and controls. Settings that are readable but not editable are marked accordingly.
- **Activity log:** Review recent actions and the account responsible for each one.
- **Protected integrations:** Only the owner can manage the playit.gg and CurseForge connections or update MineShell.

### MineShell updates

Keep MineShell itself up to date without manually replacing the installation.

- Check for new releases every 12 hours or on demand.
- View release notes and install updates from the web interface.
- Apply updates in place and restart MineShell while Minecraft servers continue running.

## Requirements

- Linux with systemd.
- Node.js 22.12 or newer.
- `journalctl`, provided by systemd.
- A compatible Java runtime for each Minecraft version. MineShell can discover or download supported runtimes.

MineShell is intended for self-hosted use on a Linux machine. It is not a multi-tenant hosting panel: Minecraft servers run under the same Linux account as MineShell. Users granted access to files, mods, or Java and loader settings may be able to execute programs as that account. Only grant those permissions to people you trust.

## Installation

Run the installer as the Linux account that should own and run the Minecraft servers, **not as root**.

```sh
curl -fsSL https://github.com/Manyullyn17/MineShell-Reloaded/releases/latest/download/install.sh | bash
```

The installer installs MineShell into `~/mineshell`, writes configuration to `~/.config/mineshell/mineshell.env` without overwriting an existing settings file, and sets up a systemd user service that starts at boot. The default port is `3000`. Running the installer again updates an existing installation.

Open MineShell in your browser and set the owner account's password on first visit. The initial account name is `admin`.

For installation options, directory layout, and uninstall instructions, see [Deployment](docs/DEPLOYMENT.md).

## Development

Clone the repository and install dependencies:

```sh
npm ci
cp .env.example .env
npm run setup
npm run doctor
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

The production server respects `PORT` and `HOST` from `.env`.

If `doctor` reports that lingering is not enabled, run the following so user services can continue running after logout:

```sh
loginctl enable-linger "$USER"
```

Keep development data separate from any production MineShell installation by using a separate `MINESHELL_DATA` and `MINESHELL_UNIT_PREFIX`.

Run the test suite with:

```sh
npm test
```

Tests run offline and do not touch real server data. For watch mode and further details, see [tests/README.md](tests/README.md).

## Configuration

MineShell is configured through environment variables. Installed instances read them from their settings file; development instances use `.env`.

See [`.env.example`](.env.example) for the complete list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINESHELL_DATA` | `~/.local/share/mineshell` | Data directory for server instances and application data. |
| `MINESHELL_AUTH` | `on` | Authentication toggle. Disable only on a network you fully trust. |
| `MINESHELL_UNIT_PREFIX` | `minecraft` in development; `mineshell` in the installer | Prefix for systemd instance units. |
| `CURSEFORGE_API_KEY` | Unset | Optional CurseForge API key for improved metadata access. Can also be configured in MineShell. |
| `BODY_SIZE_LIMIT` | `Infinity` in the example configuration and installer settings | Controls request body size. Production rejects uploads larger than 512 KB when this is unset. |

## Documentation

- [Deployment guide](docs/DEPLOYMENT.md) — installation, configuration, and maintenance.
- [Architecture](docs/ARCHITECTURE.md) — implementation details and design decisions.
- [Roadmap](docs/ROADMAP.md) — planned work and deferred features.
- [Test documentation](tests/README.md) — test setup and behavior.

## Project layout

```text
migrations/          SQL migrations applied at startup
scripts/             Setup and diagnostic tools
src/lib/server/      systemd, RCON, journal, mod providers, scheduling,
                     monitoring, world operations, and other server-side logic
src/lib/shared/      Shared browser/server utilities, formatting, console handling, NBT
src/lib/components/  Shared UI components
src/routes/          Pages and endpoints
tests/               Test helpers, flow tests, fixtures, and recorded crash/log data
docs/                Architecture, deployment, and roadmap documentation
```

## Theming

MineShell's colors are defined using CSS custom properties in `src/app.css`. To add a theme, define a `[data-theme='name']` block and add an entry to `src/lib/shared/themes.ts`. The theme picker updates automatically.

The default theme is Deep Slate.

## License

See the repository's [LICENSE](LICENSE) file for licensing information.

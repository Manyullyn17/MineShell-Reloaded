# Architecture

Notes on why MineShell is put together the way it is. Aimed at future-you, coming back to
this after six months away.

---

## Process model

Every Minecraft server is a systemd service. There is exactly one unit file —
a template, `minecraft@.service` — and each instance is an instantiation of it:
`minecraft@survival.service`, `minecraft@skyblock.service`, and so on. The instance id is
the slug, and it doubles as the systemd instance name and the directory name, so there is
never a mapping table to keep in sync.

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

### Restart policy

`Restart=` cannot come from an environment file — systemd reads unit directives before the
environment file exists. So per-instance restart behaviour is written as a drop-in at
`<unit>.d/restart.conf` instead, and `writeRestartPolicy()` owns that file.

### User scope by default

MineShell defaults to `systemctl --user`, which needs no root at all. The cost is that
services stop when the user's last session ends unless lingering is enabled — hence the
`loginctl enable-linger` step in setup and the check in `doctor`.

Set `MINESHELL_SYSTEMD_SCOPE=system` to use system units instead. Then MineShell needs
either to run as root or to have narrow sudo rules; `docs/DEPLOYMENT.md` has them. The
scope also changes how the journal is read — `journalctl --user-unit=X` for user scope,
`journalctl -u X` for system — which is handled in `journal.ts` and is easy to get wrong.

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

RCON returns structured responses. They are used for things like the online player list
and kick confirmation, but deliberately not echoed into the raw console text, which stays
a faithful view of the log.

---

## Data

SQLite through Drizzle, in WAL mode with foreign keys on and a busy timeout set.

Migrations are plain `.sql` files in `migrations/`, inlined at build time by
`import.meta.glob('/migrations/*.sql', { query: '?raw' })` and applied by a small runner
that records what it has done in a `_migrations` table. This means the production bundle
has no migration tooling in it and no filesystem dependency on the source tree —
`drizzle-kit` is a development convenience for authoring, never a runtime dependency.

Tables: `server_instances`, `mods`, `instance_mods`, `resource_samples`, `java_runtimes`,
`settings`, `sessions`, `audit_log`.

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

---

## Mods and packs

`ModProvider` is one interface with three implementations: Modrinth (its own API),
CurseForge and FTB (both through `api.modpacks.ch`). Adding a source means implementing
search, project, versions and version, and adding it to the registry.

Pack import detects the format from what is inside the archive: `modrinth.index.json`
means an mrpack, `manifest.json` means CurseForge. Both resolve to the same internal
`ParsedPack` shape, so downstream code does not care which it was.

Two details worth keeping:

- mrpack files carry per-file environment flags. Files marked `env.server === "unsupported"`
  are skipped, otherwise you install a pile of client-only mods that crash on boot.
- `overrides/` and `server-overrides/` both get applied, with server-overrides winning.

Mods are always downloaded fresh per instance. No shared cache, no symlinks. This is
deliberate: modpacks sometimes ship a patched jar under the same version label as the
upstream one, and a shared cache would serve the wrong file with no way to tell. Disk is
cheaper than that bug. A `hash` column exists on `instance_mods` for a future opt-in
cache-by-hash, but nothing reads it yet.

---

## Safety and confinement

**Path traversal.** Every file operation goes through `safeJoin()` in `files.ts`, which
resolves the result and verifies it is still inside the instance directory. The file
browser, uploads, mod deletion and the text editor all use it. Deletion additionally
refuses to operate outside `INSTANCES_DIR`, so a corrupt database row cannot point
`rm -rf` at something interesting.

**Secrets.** RCON passwords are AES-256-GCM encrypted with a key in a `0600` file
(`secret.key`) beside the database. Losing the key means regenerating RCON passwords,
which the UI can do.

**Auth.** A single admin password, scrypt-hashed, with session cookies and a per-IP
attempt throttle. The original notes left this open, wondering whether LAN-only made it
unnecessary; it is on by default because "LAN-only" tends to stop being true — a guest
device, an IoT box, a Tailscale exit node — and this application can delete a world.
`MINESHELL_AUTH=off` disables it and says so plainly on the settings page.

---

## Frontend

SvelteKit 2, Svelte 5 runes, no UI framework. Server state comes from `load` functions and
form actions; only the genuinely live things (console, stats, task progress) use SSE.

There is no separate REST API layer. The notes reasoned that no other consumer is planned,
so endpoints exist only where a form action cannot do the job: SSE streams, file
downloads, and the search endpoints the browse-and-install forms call as you type.

Styling is one stylesheet of custom properties. Two rules carry meaning rather than taste:
monospace is used only for machine output — paths, versions, ports, log lines, metrics —
and never for MineShell's own writing; and motion appears only on state change, never as
decoration, because a page that animates while a server is crashing is a page you stop
trusting.

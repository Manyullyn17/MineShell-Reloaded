# Deployment

Getting MineShell running on the machine that will actually host your servers.

Servers run as systemd **user** units of the account MineShell runs as: `systemctl --user`,
no root, nothing written to `/etc`, and a bug in MineShell cannot touch anything that
account cannot already touch. (A system-scope mode with sudo rules existed until October
2026; it ran every server as root and was removed.)

Servers come back after a reboot only if MineShell itself starts at boot: it starts them
once it is up (each server's "When the computer starts" setting), and a server's Settings
say so while MineShell is not running as a systemd service. The installer (below) sets that
up; with a git checkout it is a unit file you write.

---

## Lingering

User services stop when the account's last session ends, and do not start at boot before
someone logs in. Lingering fixes both. The installer turns it on when the system lets an
account do that for itself; otherwise, or with a git checkout, run it once:

```sh
loginctl enable-linger $USER
```

Check it took:

```sh
loginctl show-user $USER -p Linger --value    # should print: yes
```

### A dedicated account (optional)

To keep the servers away from your own files, run MineShell under its own account, for
example `mineshell`, with lingering enabled for that account. It still needs no root:
everything runs as that user's units. Start MineShell as that user's own user service
(below), not as a system service: `systemctl --user` needs the account's user manager, which
lingering keeps running.

```sh
sudo useradd --create-home mineshell
sudo loginctl enable-linger mineshell
sudo machinectl shell mineshell@     # a full session as that user; install and set up there
```

`sudo -iu mineshell` also works, but it does not set `XDG_RUNTIME_DIR`, so `systemctl
--user` cannot find the user manager until you `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.
(`machinectl` comes with the `systemd-container` package.)

---

## Installing

```sh
curl -fsSL https://github.com/Manyullyn17/MineShell-Reloaded/releases/latest/download/install.sh | bash
```

Run it as the account MineShell should run as (not root). It needs Node.js 22.12 or newer,
`curl`, `tar` and `sha256sum`. A distribution's own Node package is often older (Ubuntu
24.04 ships 18): NodeSource's packages or nvm give a current one. The installer:

- downloads the newest release (a ready-built archive with its runtime `node_modules`, so no
  npm and no compiler) and checks its SHA-256;
- puts it in `~/mineshell/releases/<version>/`, with `~/mineshell/current` pointing at the
  one that runs;
- writes the settings file `~/.config/mineshell/mineshell.env` if there is none (data in
  `~/.local/share/mineshell`, server units `mineshell@<id>`, port 3000, sign-in on) - it
  never changes an existing one;
- installs the template unit for the servers, and the user service `mineshell.service`,
  enabled so it starts at boot;
- turns on lingering if it can (otherwise it says to run `sudo loginctl enable-linger $USER`);
- starts MineShell and waits until it answers.

Open `http://<server-ip>:3000`, set an admin password, add a server.

It refuses, before changing anything, when `~/mineshell` or `mineshell.service` exist and
were not made by it. Options are environment variables on the `bash` side of the pipe, e.g.
`curl ... | MINESHELL_DATA=/srv/mineshell-data PORT=8080 bash`:

| Variable | Default | |
| --- | --- | --- |
| `MINESHELL_VERSION` | the latest | A release tag, e.g. `v0.2.0` (also for going back) |
| `MINESHELL_HOME` | `~/mineshell` | Where the program goes |
| `MINESHELL_CONFIG` | `~/.config/mineshell/mineshell.env` | The settings file |
| `MINESHELL_SERVICE` | `mineshell` | The user service's name |
| `MINESHELL_NODE` | `node` on `PATH` | The Node binary the service runs |
| `MINESHELL_DATA`, `MINESHELL_UNIT_PREFIX`, `PORT` | see above | First install only: written into the new settings file |

The service runs the Node binary the installer found, by its full path. With nvm, that path
names one Node version: after removing it, run the installer again.

Settings are the variables in `.env.example` (in the release folder). Put `MINESHELL_DATA`
on whatever disk has room: modpack instances are several gigabytes each and worlds grow.
After editing the settings file, `systemctl --user restart mineshell`.

### From a git checkout instead

For development, or to run unreleased code:

```sh
git clone https://github.com/Manyullyn17/MineShell-Reloaded.git ~/mineshell-src
cd ~/mineshell-src
npm ci
cp .env.example .env      # MINESHELL_DATA, PORT, HOST, BODY_SIZE_LIMIT=Infinity
npm run setup             # directories + template unit + daemon-reload
npm run doctor            # verifies systemd, journal, lingering, Java, permissions
npm run build
npm start
```

To start it at boot, write `~/.config/systemd/user/mineshell.service` by hand:

```ini
[Unit]
Description=MineShell
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/mineshell-src
EnvironmentFile=/home/you/mineshell-src/.env
ExecStart=/usr/bin/node build/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

`ExecStart` needs the full path `which node` prints (the service does not see nvm). Then
`systemctl --user daemon-reload && systemctl --user enable --now mineshell`. The `.env`
needs `BODY_SIZE_LIMIT=Infinity`: the production server's default request limit of 512 KB
refuses mod jar, modpack and world uploads (a body is only read once the request has passed
the sign-in check). Keep a checkout that runs as a service apart from one you develop in, with
its own data directory and unit prefix: two MineShells on one data directory roll back each
other's operations at startup and both run the scheduler.

---

## Starting at boot, and what survives a stop

The installer's `mineshell.service` is enabled, and lingering starts the account's user
manager at boot without a login, so MineShell comes up with the machine; it then starts the
servers whose "When the computer starts" setting says so. `npm run doctor` (in the release
folder: `MINESHELL_ENV_FILE=~/.config/mineshell/mineshell.env node scripts/doctor.mjs`) checks
lingering and the rest.

If MineShell is stopped, your Minecraft servers keep running: they are independent
systemd units, not children of the panel. That is the point of the design.

---

## Upgrading

Settings > Updates: MineShell checks GitHub for a new release every 12 hours (it can be
turned off) and on "Check now", shows "Update <version>" in the top bar when there is one,
and installs it with the Update button - the same as running the installer again, which also
works. The update waits while a task or a server change is running (the restart would cut it
short), and if the installer fails, the page shows its log and the old version keeps running.
A MineShell installed with 0.1.0's installer needs one update by hand (the command below):
that is what lets it update itself.

Running the installer again: it installs the newest release next to the running one, switches
`current` over, rewrites `mineshell.service` and restarts it; the settings file and the data
are left alone, and the two previous releases stay in `releases/`. To go back, run it with
`MINESHELL_VERSION=v<older>`. Restarting MineShell does not touch running servers.

Database migrations run automatically at startup. Back up
`$MINESHELL_DATA/mineshell.db` first if you want to be careful; it is a single file.

The template unit does not need reinstalling: at startup MineShell rewrites an installed
template that an older MineShell wrote. Reinstalling it is safe anyway — the Settings page
has a button for it, and it re-syncs every instance's environment file and drop-ins
afterwards. `npm run setup` writes the same template.

From a git checkout: `git pull && npm ci && npm run build && systemctl --user restart mineshell`.

### Uninstalling

`systemctl --user disable --now mineshell`, then remove `~/.config/systemd/user/mineshell.service`,
`~/mineshell` and, if you want, the settings file and the data directory. Stop the servers
first: their template unit is `~/.config/systemd/user/mineshell@.service`.

### Publishing a release

On `main`, with everything committed and CI green:

```sh
npm run release                          # or: npm run release -- -m "Intro for the notes"
git push origin main v<version>          # the command it prints
```

`scripts/release.sh` picks the version from the commits since the last tag, bumps
`package.json`, commits `chore: version <version>`, tags it and shows the release notes; it
pushes nothing. The rules:

| Since the last release | Before 1.0 | From 1.0 on |
| --- | --- | --- |
| only `fix:` | patch (0.3.0 -> 0.3.1) | patch |
| any `feat:` | minor (0.3.1 -> 0.4.0) | minor |
| a breaking change, marked `feat!:` or `fix!:` (a manual step, renamed settings, an older Node dropped) | minor, with a "Before updating" note in the intro | major |
| nothing but `docs:`, `test:`, `ci:`, `chore:` | no release | no release |

`npm run release -- patch|minor|major|<x.y.z>` overrides it. 1.0 is a decision, not a rule:
the first version to recommend to other people as stable.

The pushed tag starts the Release workflow: the CI checks, the archive
(`scripts/package.sh`), one start of it on a throwaway data directory (`scripts/smoke.sh`),
then the release with its checksum and `install.sh`. CI packs and smoke-tests on every push too.

The release notes (`scripts/release-notes.sh`, also shown on Settings > Updates before
updating) are the tag message after its first line, then the commits since the previous
tag: `feat:` under "New", `fix:` under "Fixed", by subject; `docs:`, `test:`, `ci:` and
`chore:` are left out.

---

## Network exposure

MineShell is designed for a LAN. It has no rate limiting beyond the login throttle, no
audit trail suitable for a shared environment, and its file browser can read every file in
an instance directory.

If you want to reach it from outside your network, put it behind Tailscale or a similar
mesh VPN. That gets you an encrypted, authenticated path without exposing anything to the
public internet.

If you must expose it directly, terminate TLS at a reverse proxy and keep the app bound to
localhost. One nginx detail: SSE needs buffering off, or the console will appear frozen
and then dump everything at once.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Keep both `Host` and `X-Forwarded-Proto`: MineShell refuses form submissions whose browser
`Origin` names a different host from the one the request was sent to (`Host`, or
`X-Forwarded-Host` if your proxy sets it), which stops other sites driving your panel, and
marks the login cookie `Secure` when the browser used https.

For players outside your network without opening ports, link playit.gg (MineShell settings,
Integrations) and make the server public in its settings: playit's agent runs as the user unit
`<prefix>-playit.service` next to the servers (`journalctl --user -u <prefix>-playit` for its
log), only connecting out. A free account takes one agent: remove old ones on playit.gg, or
the new one is turned away until you do.

Never expose an RCON port. It is plaintext and only weakly authenticated, and only MineShell
on the same machine needs it. Minecraft listens for RCON on every interface unless
`server-ip` is set (which binds the game port to that address too), so keep the RCON ports
closed in the firewall and open only the game ports. New servers get their RCON port 1000
above the game port (25565 -> 26565), so the two ranges are easy to tell apart in a firewall
rule; servers made before October 2026 have theirs from 25575 up.

---

## Troubleshooting

**`npm run doctor` says systemctl is unreachable.**
The process cannot reach the account's user manager. This happens when MineShell is started
from a system service, from cron, or over an SSH command with no PTY. Run it as a user
service (above), with lingering enabled.

**A server will not start and the console is empty.**
Check the unit directly:

```sh
systemctl --user status minecraft@<id>
journalctl --user-unit=minecraft@<id> -n 100 --no-pager
```

The usual causes are a missing or mismatched Java runtime, the EULA not accepted, or a
port already taken (MineShell checks the ports before starting and says so).

**Console shows nothing but the server is clearly running.**
Journal permissions. Some distributions keep the journal only in memory or do not split it
per user, and then an account cannot read its own units' output. Add the account to
`systemd-journal` (`sudo usermod -aG systemd-journal $USER`, then log in again), or make the
journal persistent (`sudo mkdir -p /var/log/journal`). Confirm with
`journalctl --user-unit=minecraft@<id> -n 5` as that account.

**Server starts, then stops seconds later, repeatedly.**
A crash loop. systemd gives up after the configured attempt limit; the overview page shows
the last output before it stopped and, usually, which mod caused it (a missing dependency,
a client-only mod on a server, a mixin failure), with a button to disable it. Otherwise
check the log for the mod named in the stack trace and disable it from the Mods page.

**"Java 21 expected, found 17."**
Download it in Settings → Java runtimes (Eclipse Temurin or Azul Zulu), or install it
through your package manager and Scan again. If it is somewhere unusual, add it by path.
Creating a server or changing its loader or pack offers the download when the Java it
needs is missing.

**Everything worked, then stopped after a reboot.**
Lingering was never enabled, so your user services did not come back.

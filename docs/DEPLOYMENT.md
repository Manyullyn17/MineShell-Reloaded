# Deployment

Getting MineShell running on the machine that will actually host your servers.

Servers run as systemd **user** units of the account MineShell runs as: `systemctl --user`,
no root, nothing written to `/etc`, and a bug in MineShell cannot touch anything that
account cannot already touch. (A system-scope mode with sudo rules existed until October
2026; it ran every server as root and was removed.)

One decision is left: whether MineShell itself should start at boot (below).

---

## Lingering

User services stop when the account's last session ends, and do not start at boot before
someone logs in. Lingering fixes both. Run it once:

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
git clone <your repo> /srv/mineshell
cd /srv/mineshell
npm install
```

Create `.env` from `.env.example`. On a server you will usually want:

```
MINESHELL_DATA=/srv/mineshell-data
MINESHELL_AUTH=on
PORT=3000
HOST=0.0.0.0
```

Put `MINESHELL_DATA` on whatever disk has room. Modpack instances are several gigabytes
each and worlds grow.

Then:

```sh
npm run setup     # directories + template unit + daemon-reload
npm run doctor    # verifies systemd, journal, lingering, Java, permissions
npm run build
npm start
```

Open `http://<server-ip>:3000`, set an admin password, add a server.

---

## Starting MineShell at boot

MineShell manages your Minecraft servers; something has to manage MineShell. A user
service is the simplest answer.

`~/.config/systemd/user/mineshell.service`:

```ini
[Unit]
Description=MineShell
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/mineshell
EnvironmentFile=/srv/mineshell/.env
ExecStart=/usr/bin/node build/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

`/usr/bin/node` has to be Node.js 22.12 or newer, which a distribution's own package often is
not (Ubuntu 24.04 ships 18). With Node from NodeSource it is; with nvm, put the full path
`which node` prints into `ExecStart` instead. `npm run doctor` reports the version it ran with.

```sh
systemctl --user daemon-reload
systemctl --user enable --now mineshell
systemctl --user status mineshell
```

Lingering (above) is what makes this survive logout.

The `.env` needs `BODY_SIZE_LIMIT=Infinity` (in `.env.example`): the production server's
default request limit of 512 KB refuses mod jar, modpack and world uploads. A body is only
read once the request has passed the sign-in check.

If MineShell is stopped, your Minecraft servers keep running — they are independent
systemd units, not children of the panel. That is the point of the design.

---

## Upgrading

```sh
cd /srv/mineshell
git pull
npm install
npm run build
systemctl --user restart mineshell
```

Database migrations run automatically at startup. Back up
`$MINESHELL_DATA/mineshell.db` first if you want to be careful; it is a single file.

The template unit does not need reinstalling: at startup MineShell rewrites an installed
template that an older MineShell wrote. Reinstalling it is safe anyway — the Settings page
has a button for it, and it re-syncs every instance's environment file and drop-ins
afterwards. `npm run setup` writes the same template.

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

Never expose an RCON port. It is plaintext and only weakly authenticated, and only MineShell
on the same machine needs it. Minecraft listens for RCON on every interface unless
`server-ip` is set (which binds the game port to that address too), so keep the RCON ports
closed in the firewall and open only the game ports.

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

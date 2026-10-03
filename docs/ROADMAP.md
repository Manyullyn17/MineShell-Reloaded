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
server copies, Java downloads, mod updating and the smaller operational features -
countdown stops, TPS, scheduled commands, resource limits, stuck-start warning, log
history, server icon - are built.)

### Mod updating: what is left

Built: "Update mods" (check, review, update; world snapshot per the policy) and switching
one mod to any compatible version, older ones included (world snapshot opt-in), journalled
as `mod-update`. On a modpack server both are greyed out until a toggle is turned on.
Not built from the original design:

- Downgrade/disabled-mod options: disabled mods are updated and stay disabled; nothing asks.
- Required dependencies are installed, but nothing checks `incompatible` ones or removes a
  dependency the new version no longer needs.

### Notifications

A Discord webhook on crash loops and scheduled restarts. The event bus in `events.ts`
already emits everything needed, so this is a settings form, a fetch, and a subscriber.
Deliberately kept out of v1 to avoid designing a notification framework for one webhook.

### CurseForge installs through the official API, not just metadata

A CurseForge API key (Settings page) currently only upgrades *metadata*: search, browse,
project details, description and changelog go through `api.curseforge.com` instead of the
modpacks.ch mirror once a key tests as working (see `lib/server/mods/curseforge.ts` and
`curseforge-official.ts`). Installing a picked pack still resolves its file list through
the mirror regardless of key state, because modpacks.ch conveniently hands back a
pre-flattened per-mod-file list for a modpack version, and the official API does not - a
CurseForge modpack "file" through that API is the pack's zip (`manifest.json` plus an
`overrides/` folder), the same format `lib/server/packs/index.ts` already parses for
uploaded CurseForge zips.

Going further - making the official API the source for installs too, not just browsing -
means: download that zip via the resolved `downloadUrl`, parse its manifest with the
existing `parseCurseforge()` parser, and resolve each `{projectID, fileID}` pair
individually (`resolveCurseforgeDownload()` already does the per-file part, for uploads).
Two things make this worth doing eventually rather than immediately:

- It would let installs prefer a modpack's dedicated **Server Pack** file
  (`isServerPack`/`serverPackFileId` on the CurseForge file object) over the default
  client file. Client-only mods slipping into server installs are now caught after the
  fact (`clientonly.ts` disables what Modrinth or the jar itself says is client-only), but
  that only knows what Modrinth knows; a proper Server Pack zip is curated by the pack
  author to exclude client-only mods in the first place.
- It also means `overrides/` support (server.properties tweaks, config files bundled in
  the pack) for CurseForge packs picked through the browser, which today only the Upload
  flow gets.

Not started. The metadata-only version above was deliberately scoped smaller because the
happy path here could not be verified live (no working CurseForge API key was available
while building it) - this is a bigger, riskier follow-up that deserves its own pass with a
real key in hand to confirm the file/manifest shapes against.

---

## Later

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

### Modpack install flow refinements

Show a pack's mod list before installing it; "Install" vs "Install & Start"; a UI for
choosing what to do with client-only mods (see `clientonly.ts` for what is detected today).

### Data packs from the mod browser

Modrinth projects that only publish a data pack `.zip` (no loader `.jar` build) show up in
the mod browser but have no installable versions, because versions are listed for the
server's loader. Install those into `<level-name>/datapacks/` instead, tracked like a mod.

### Pack change preview: content in data-pack-loader folders

Folders like `config/paxi/datapacks`, `config/openloader`, `global_packs/` or `kubejs/`
are pack config folders, so a pack change moves them whole to `old-configs/` - including a
data pack the user added there. Correct by the configs policy, but easy to miss for a data
pack; the preview could point out non-pack files in those folders.

### Player data editor

View and edit a player's inventory and NBT data from the players page.

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

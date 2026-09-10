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

---

## Dependency order

Some of these unlock others. Rough ordering:

```
mod updates ──────────► duplicate detection across platforms
     │
     └────────────────► hash-based mod cache

Java auto-install ────► (nothing; standalone)

notifications ────────► needs no new infrastructure, the event bus already exists

remote access ────────► depends on the auth model, which is now settled
```

Mod updates are the biggest unlock and the most involved. Everything else is largely
independent and can be done in any order.

---

## Near term

### Mod updating

Currently mods can be installed, enabled, disabled and deleted, but not updated. The
original TUI design worked this out in detail and that design still holds:

- Three update modes: pack-only, everything, or per-mod selection.
- Deduplicate by project id, skip files already at the right version by hash.
- Downgrade handling when an installed mod is newer than the pack specifies: ask (default),
  keep, or force down.
- Disabled-mod behaviour: update but leave disabled (default), skip entirely, or update and
  re-enable.
- Mods removed from an updated pack are deleted only if tagged as coming from the pack.
  User-added mods are never removed automatically.

The safety workflow is the part worth implementing carefully: snapshot the mods folder and
its metadata, write a marker file once the snapshot is complete, update mods one at a time
writing metadata after each, remove the marker on success. On next launch, a marker that
still exists means the last update was interrupted, so restore the snapshot. Either the
update fully succeeded or the folder is untouched.

The schema already supports this — `instance_mods` carries `version`, `hash`, `locked` and
a from-pack flag — so no migration is needed to start.

### Java auto-install

Right now a missing Java runtime produces a warning telling you to install one. The target
is Prism Launcher's behaviour: fetch the right JDK from the Adoptium API and unpack it into
the data directory.

`adoptiumDownloadUrl()` in `java.ts` is a deliberate stub marking where this goes. It is
low risk and self-contained; the only real work is architecture detection and unpacking.

### Notifications

A Discord webhook on crash loops and scheduled restarts. The event bus in `events.ts`
already emits everything needed, so this is a settings form, a fetch, and a subscriber.
Deliberately kept out of v1 to avoid designing a notification framework for one webhook.

### Configurable instance-creation defaults

Every default a new instance gets right now is either hard-coded or computed on the spot -
`suggestedMaxMb` in `instances/new/+page.server.ts` guesses from total system RAM, starting
memory is a bare `1024` in the new-instance form, JVM preset/restart policy/console buffer
sizes are whatever `instances.ts` falls back to when a field is left blank. None of it is
stored or user-editable; it is recalculated or hard-coded fresh every time.

The goal: one place on the global settings page where every one of those defaults can be
overridden, read by the new-instance form (replacing the inline fallbacks) and by
`instances.ts`'s own defaulting logic. Needs a small schema addition to hold them (a
single-row table, or a key-value table if the list keeps growing) plus a form. No design
work has started - first real decision is which defaults belong here versus staying
computed (system RAM detection for suggested memory is arguably still worth keeping as the
*default* default, with a stored override on top, rather than replacing it outright).

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

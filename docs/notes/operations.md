# Operations: journalled changes, export, bisect, defaults

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Interrupted operations
- Pack change, loader change, Cleanroom migration/revert and first install are journalled in
  the `operations` table (`operations.ts`); `recovery.ts` runs at boot. A row means "not
  committed": `commitOperation` writes the result and deletes the row in one transaction.
  Moves are renames into the op's own folder, so recovery reads what moved from disk
  (`restoreAside`, `restorePackChange` - shared with the in-process rollback).
- Rows carry a per-process token (on globalThis) and recovery skips its own; the boot guard
  is on globalThis too, because dev HMR re-runs module code.
- So does any module state that must outlive a dev reload: the task list and event bus
  (`tasks.ts`, `events.ts`; before 2026-10-17 a reload left open pages' task streams deaf -
  no progress, no reload when a task finished), the RCON pool. A test re-evaluates a module
  with `import('./x.ts?copy=<n>.ts')` (the query must end in .ts to be transformed).
- Tests simulate a crash with `tests/helpers/crash.ts` (freeze at the n-th move, then
  `restartMineShell()`); verified once for real with kill -9 mid Forge install.
- Installers write their `*-installer.jar.log` into the server folder (their cwd).

## Server export and import
- `serverbundle.ts` (built 2026-10-19): one zip, `mineshell-export.json` + `files/`. Mods Modrinth
  knows by sha512 or with a CurseForge row are listed and downloaded again on import; the loader
  is installed again. Besides the rest of `isLoaderInstallEntry`, `.fabric-cache/` (MineShell's Fabric install
  caches the vanilla jar there, 52 MB) and `versions/` (the vanilla bundler unpacks it on start)
  stay out: with them a small Fabric server's export was 69.7 MB, without 467 KB. So does
  `.cache/quilt_loader` (2026-10-25): Quilt's remapped game jars, a set per loader build and
  Minecraft version it ever ran (rebuilt at start); a Quilt server moved once exported 100 MB, 35 without.
- Backup mods write their own world copies into the server folder: AromaBackup and FTB
  Utilities (1.12) default to `backups/`, Simple Backups to `simplebackups/`. On MeatballCraft
  AromaBackup's were 21 GB beside a 7.1 GB world; they were carried by every export until
  they became a choice, off by default (2026-10-26).
- yauzl refuses entries named outside the folder (`../x`) with its own error: `readManifest`
  reads every entry once so such a file is refused at the preview, before anything is created.
- Tried end to end on a throwaway dev server (Fabric 1.21.1, two Modrinth mods, a hand-made one,
  exported while running, imported, booted). By the user 2026-10-26 on the dev copy of
  MeatballCraft (CurseForge pack on Cleanroom 0.5.17, 7.1 GB world): the copy was
  byte-identical apart from what was left unticked and the machine's ports and RCON password,
  booted with no warning the original lacks, and was joined. Empty folders do not travel
  (119 there; a zip holds only what has files): left so (user's call, 2026-10-26), mods make
  their folders when they need them.

## Mod bisect assistant
- `bisect.ts`: ddmin over the enabled mods minus keep-on, dependency closure from crashdiag's
  index, learned deps from "disabled-dependency" diagnoses. Throwaway world via level-name,
  config/ copied aside, journalled (`bisect`), test runs marked via `bisect_sessions`.
- Live-tested on a throwaway Fabric 1.21.1 server with five fake mods and one needing a
  missing library: found in 5 starts (the estimate), everything restored. Not tried on a big
  pack, nor with the log-text option or a two-mod interaction outside tests.

## New server defaults
- `instance-defaults.ts`: one JSON row in `settings` (`instance.defaults`), edited at
  `/settings/defaults`, read only at creation (`insertInstanceRow`, the new-server form).
  Every read goes through validation, so a stale or hand-edited row degrades to built-ins.
  Max memory `null` = the RAM guess (`suggestedMaxMb`). Game settings store only values that
  differ from built-in. Per-instance keys (ports, RCON, MOTD, level name/seed/type) are never
  defaults. Restart/console/property fields are shared components (`RestartFields`,
  `ConsoleFields`, `PropertyInput`) and parsers with the per-instance pages.
- `server.properties` is Java's properties format, read and written as Java does
  (`readJavaProperties`, `serialiseProperties`; 2026-10-28). Minecraft rewrites it at every start
  with `\:` `\!` `\\` escaped (1.12.2 and 1.21.11 both), and up to 1.12 at least reads it as
  Latin-1: a UTF-8 "Gemütlich" motd came back as `Gem\u00C3\u00BCtlich`. Letters past ASCII are
  written as `\uXXXX` (every version reads that); the raw editor shows them as letters.
  Tried by running both vanilla jars on a scratch file (`tests/tools/mc-probe.mjs` does that).

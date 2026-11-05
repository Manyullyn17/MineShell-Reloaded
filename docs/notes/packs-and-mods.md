# Modpacks and mods

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Modpacks and the modpacks.ch mirror
- File lists ship configs/scripts/bundled jars as one `overrides.zip` at path `./` -> becomes
  `pack.overridesArchive`, unpacked like an archive's `overrides/`. Paths are inconsistent
  (`mods/` and `./` in one response); `packFromFileList` normalises.
- The version *list* tags every compatible game version (`1.12` and `1.12.2`); only the
  version *detail* has the exact target and loader build. With an official CurseForge key,
  metadata comes from the official API but the install target always from the mirror.
- Single CurseForge mods: `/public/mod/{id}` (not the pack endpoint `/public/curseforge/{id}`,
  whose mod versions carry no files) has URL, sha1, size, deps and `clientonly` per file - but
  only the newest 50 files. Older ones: `/public/mod/{id}/versions/{mc}[/{loader}][/{page}]`,
  50 per page, newest first; untagged old files still match a loader filter. No lookup by
  file id, so `getVersion` takes a Minecraft version to page with. Term search
  `/public/mod/search/{n}?term=` mixes CurseForge (numeric) and Modrinth (string) ids.
- Pack file lists carry `curseforge: {project, file}` per mod; that (and manifest.json's ids)
  is how pack mods get tracked as CurseForge. A CurseForge mod's `slug` is its numeric id.
- `resolveProviderPack` is the one provider-version -> ParsedPack path.
- A project with no name of its own is `project-<id>` on CurseForge itself (the mirror and
  CFWidget agree, 2026-11-03): Litematica, MiniHUD and Tweakeroo for Fabric 1.21.11 (1205459,
  1207445, 1207454, by Marceus), with real icons, summaries and files. The Mods list takes the
  jar's declared name instead and stores it on the mod's row (`nameFromJar`, mods/index.ts).
- Download hosts (checked 2026-10-10 on 7 FTB and 4 CurseForge packs, ATM9/10 and
  MeatballCraft among them): every entry had a URL; CurseForge jars point at
  `edge.forgecdn.net` (a redirector to `mediafilez.forgecdn.net`, the fallback source), FTB's
  configs/kubejs/own jars at `dist.modpacks.ch` with no CurseForge ids. Failed files go to
  `.mineshell/missing-downloads.json`, listed on the overview (`packs/missing.ts`).
- Node's built-in fetch (undici 7, Node 22 and 24) crashes the whole process
  (`assert(!this.paused)` in `Parser.finish`, thrown from a socket event, so no catch reaches
  it) when a server sends a complete large body and closes the connection (`Connection:
  close`, or HTTP/1.0 as Python's `http.server`) while the file write holds the stream back.
  A connection dropped halfway fails cleanly. Found 2026-10-25 by a self-update from a local
  Python server; undici 8.12 (needs Node 22.19) does not crash. Every host MineShell
  downloads files from keeps connections alive (checked then: piston-data.mojang.com,
  cdn.modrinth.com, edge/mediafilez.forgecdn.net, dist.modpacks.ch, the Forge, NeoForge,
  Fabric and Quilt mavens, Adoptium, GitHub's release assets), so it was left as it is; a
  host that closes would take MineShell down mid-install. `tests/tools/update-source.mjs`
  serves with keep-alive for that reason.
  Fixed 2026-10-28 (next, for 1.1): still in the newest Node 22.23.4 (undici 6.29.1) and 24.22.1
  (7.30.1), not in Node 26.12 (8.12.2); the undici 8.12 package's fetch now stands in for Node's
  (`undicifetch.ts`, set in hooks.server.ts), so the minimum is 22.19. `tests/tools/fetch-close.mjs`
  shows it without Python (a raw HTTP/1.0 answer on loopback): built-in fetch crashes in round 2,
  `--undici` passes. Node's own FormData is not undici 8's and went out as "[object FormData]",
  so the wrapper copies one over; Headers, Response bodies and URLSearchParams mix fine.
- Pack version change (`packchange.ts`): pack-shipped top-level folders move whole to
  `old-configs/<date>-<version name>/`; `server.properties`, world, player lists, logs are
  never moved or replaced. The world is whatever `level-name` says (pack side and server
  side, `packworld.ts`); inside it only the pack's data packs are synced (owned ones
  recorded in `server_instances.pack_datapacks`), other world files added only if missing.
  Before this fix a pack shipping `world/datapacks` made `world` a "config folder" and the
  whole world went to old-configs; pack mods diffed by name, same-name ones compared by hash / bundled bytes;
  the user's own mods are never removed (update / current / no compatible version / unknown).
  A renamed build of the same mod (almost every update: versions are in the file name) is
  paired as an update in the preview (`replacedPackMods`, plan `mods.replaced`), by the
  provider's project: the installed row's source + slug (a CurseForge project id; a Modrinth
  project's *slug*, not its id) against the target's CurseForge project or the Modrinth
  project of its hash (`version_files`, then `projects` for the slug). Until 2026-10-27 the
  preview called each such update one mod removed and one added, and said "0 updated".
  Applying still works from `add`/`remove`, which keep both files.
- Config edits survive pack changes (`configmerge.ts`, built 2026-10-08): base =
  `.mineshell/pack-base.zip` (tagged with `baseTag(row)`; a mismatched tag is ignored and the
  installed version is fetched instead), merge step 5b in applyPackChange, report in
  `.mineshell/config-merges/<old-configs stamp>/` (removed on rollback; the old base is staged
  and put back). Overlaps take the pack's lines (user's call: merge automatically, carry the
  user's own files, fetch the old version once when there is no base). The merge is a plain
  LCS line diff (no library); a middle over 4M cells is one hunk (more conflicts, never wrong).
- `syncMods` tracks untracked jars as `fromPack` unless told otherwise; after a pack change only
  the version's own jar names count (`packFiles`), everything else is the user's. Before
  2026-10-11 every untracked jar became a pack mod there, and the following change deleted it;
  servers changed before then can still have such rows (Sync does not re-label them).
- Rollback (`packrollback.ts`, user's call 2026-10-11: approach "pack change back + exact
  configs", user mods left and named): needs the `pack_changes` row, so only changes made
  after 0.10.2 can be rolled back. Snapshot retention can delete the pre-change snapshot;
  the form then offers no world restore, and a Minecraft-moving change cannot be rolled back.
  UI checked on a throwaway dev server with a faked row; a real pack rolled back only in tests.
- An uploaded pack file is a pack change target too: `prepareUploadedPack` keeps it as
  `upload:<uuid>` in the same `prepared` map; a CurseForge zip's entries are resolved first
  (`resolvePackTargets`), since a nameless entry would diff as a dropped mod. After it the
  server has `packVersionId` null (no provider version) and the file's name/version.
- Data pack loader folders (`datapackloaders.ts`): Open Loader 21.1.5 (ATM10, NeoForge 1.21.1)
  reads `config/openloader/packs/` plus the server's `datapacks/` (`load_datapacks_dir`, on by
  default, for CurseForge's launcher) and `additional_locations` from
  `config/openloader/options.json` (strings in its jar; ATM10 ships `packs/` with its own).
  Older Open Loader builds' `config/openloader/data` and `openloader/data`, Paxi's
  `config/paxi/datapacks` and Global Packs' `global_packs/required_data`/`optional_data` are
  from their documentation, not checked in a jar. Which folders an Open Loader build reads is
  told from its jar's name (the last dotted version's first number: 21 and up `packs/`, older
  `data/`), since a pack change's new jars are not downloaded at preview; a name without a
  version counts as every folder, so no warning.

## CurseForge's official API
- The user has a key: saved in Settings of both the dev and the installed MineShell (encrypted
  in the database), not in `.env` or `mineshell.env`, whose `CURSEFORGE_API_KEY=` is empty.
  `tests/tools/curseforge-key.mjs` reads it out for recording (tests/README, "No network").
  Keys start with `$2a$10$`: sourcing a file that holds one through a shell mangles it.
- Checked against real answers 2026-11-01 (`curseforge-official-api.test.ts`): the mapping
  written from the docs held. Pack file lists hold no separate server-pack entries; file tags
  mix versions and the loader (`"1.12", "Forge", "1.12.2"`). Many 1.12 mods' files carry
  `modLoader: null`, so their search hits list no loader, yet a Forge search finds them.

- Fingerprints (`mods/fingerprint.ts`): MurmurHash2, 32 bit, seed 1, over the file with bytes
  9, 10, 13 and 32 left out; matched CurseForge's `fileFingerprint` for four MeatballCraft jars
  (2026-11-03). `POST /v1/fingerprints/432` with `{ fingerprints }` answers `exactMatches[].file`
  (`modId`, `id`, `displayName`, `fileFingerprint`); names and icons then come from
  `POST /v1/mods` with `{ modIds }`. Recording either: put the file path before any `-u`
  (vitest 5's `-u` takes a value, so `run -u <file>` ran and re-recorded every file).

- Jars' own names and versions (`mainDeclaredMod`, crashdiag.ts), surveyed 2026-11-03 on 1031
  jars of the dev servers (`tests/tools/jar-metadata-survey.mjs`): 1015 give a usable name and
  1005 a version. 58 hold several mods (Ender IO 8, Binnie 5; JourneyMap a Fabric stub
  `journeymap-wrongloader` for the wrong loader), so the one the file is named after is picked.
  `${file.jarVersion}` in mods.toml is the manifest's Implementation-Version (44 of 63 jars
  without a version had one). Many 1.12 `mcmod.info` files are not strict JSON (line breaks in
  strings: Chisel, Iron Chest). Template leftovers: modid `examplemod` with the name "Example
  Mod" (Career Bees, REIM); the rest without a name are 1.12 jars declaring nothing (AppleCore).

## Pack install form
- Picking a provider pack version fetches `/api/packs/preview` (`packs/preview.ts`): the pack's
  mods, client-only ones flagged by Modrinth hash (sha512 for .mrpack, sha1 for the mirror's
  lists) unless another pack mod requires them, and mods the pack ships as `.disabled`
  (Thread ships Fabric API that way). The resolved pack is kept 15 min and taken by the
  install (`takeProviderPack`), so a .mrpack is not downloaded twice.
- The form sends `disableMods`/`keepMods`/`enableMods`; unticked client-only mods are left
  to `disableClientOnlyMods` (which also keeps ones a jar requires). `SplitButton`'s
  "& start" accepts the EULA and starts after the task; skipped when downloads failed.
- A menu item that is also the submitter must not be removed during its click (closing
  the menu synchronously cancelled the submit).

## Mod updates
- `modupdates.ts`. Check: Modrinth mods by local sha512 in one `version_files/update` call
  per 100 (it returns the newest regardless of channel, so only mods with something newer get
  their version list read); CurseForge per project via the mirror (newest 50 per mc/loader).
  `pickUpdate`: newer than installed; a release stays on releases.
- Apply: journalled `mod-update` with the instance_mods rows in the journal; rollback rewrites
  them exactly. Keeps enabled/locked/fromPack per mod (fromPack, so a later pack change still
  replaces it). Pack servers: UI toggle + server-side `packMods=on` check.
- Disabled mods start unticked in the review, with why they are off where MineShell knows
  (client-only, off for Cleanroom); a disabled copy of a mod that is also enabled (the old
  Fugue a replacement left) is skipped, or updating both made two copies, and Installed tags
  it "other copy in use". Copies are told by the jars' mod ids (`disabledCopies`), not
  source + project: MeatballCraft's old Fugue was the pack's CurseForge one, its successor
  MineShell's Modrinth one. `incompatible` dependencies (Modrinth only) are
  warned about; `unneededDependencies` offers to disable deps only the old versions required
  (platform metadata old vs new, then no other enabled jar requires its ids). Disabling inside
  a journalled change goes through `disableStaged` (original staged, copy back as .disabled).
- The check syncs first when anything is untracked (`syncInstanceMods`, shared with Sync).
  Required dependencies (`resolveDependencies`, 4 levels) count as present by source+slug/id
  or by name (catches one installed from the other platform); installed inside the same
  journalled change, so a rollback removes them.

## Client pack export
- `packexport.ts`. Every mod starts ticked, server-only ones too (user's call: a singleplayer
  test world should match the server). Modrinth's `client_side: "unsupported"` would mark
  them, but worldgen mods (YUNG's, Moog's, Lithostitched) declare it as well.
- .mrpack downloads may only point at cdn.modrinth.com, github.com,
  raw.githubusercontent.com, gitlab.com (spec); CurseForge CDN files get bundled.
- Cleanroom publishes a Prism instance zip per release (`cleanroom-<ver>.zip`: patches/,
  mmc-pack.json, an instance.cfg whose JavaPath is a placeholder - not copied) from 0.5.x;
  0.4.4 has none.
- Tried on a copy of slimes-adventure (117 mods: 87 linked, 20 bundled, 12 client-only pack
  files added) and a fake Cleanroom server. The user imported a Prism export of
  meatballcraft-dimensional-ascension (Cleanroom) into Prism and it worked (2026-10-09).
  The .mrpack and CurseForge exports of a Cobblemon test server (Modrinth pack, 75 mods)
  imported into Prism cleanly (2026-10-26); both hold the same 75 mods and the same 2449
  other files. The CurseForge one bundles all 75 (Modrinth mods have no CurseForge ids), so
  Prism asks before importing bundled jars ("could be malware"): expected, not a fault.

## Mod list export
- `modlist.ts`. The `mods` table's author is mostly empty: Modrinth's project endpoint has no
  author (only search results carry one) and a mod is first recorded from a hash lookup. Jars
  know their authors, so the list reads them first.
- `manual` records (jars from no catalog; the Mods list says "Other", not "Uploaded": MineShell
  cannot tell an upload from a jar copied in or a pack's override) are named after the file
  (`sodium-0.6.0`), and a disabled one keeps `.jar.disabled` in its name; the jar's own name
  is used instead. Sync identifies them by Modrinth hash only, once: a CurseForge-only jar
  (Dynmap's Forge 3.7-beta-6; Modrinth's Forge 1.12.2 builds stop at 3.7-beta-4) stays
  `manual`. MineShell's own downloads from elsewhere (DynmapBlockScan) are recorded with
  name, version and link, and the list shows the link's host.
- Forge/NeoForge mods.toml `version` is often `${file.jarVersion}` left unreplaced; treated as
  no version.

Modrinth's dependencies are per version, not per loader: a multi-loader version lists the same
ones for every loader, so Netherracked's Fabric builds name Create (Forge and NeoForge only;
Create Fabric is another project) as optional, and Add mods truthfully says it has no Fabric
build. Client-only mods are left out of searches on purpose: searching "sodium" finds no Sodium.

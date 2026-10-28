# Loaders, Java and migration

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Loaders and Java
- Install shapes: vanilla/Fabric 0.12+ -> `-jar server.jar`; **Fabric < 0.12** has no
  server-jar endpoint (meta answers 400) -> full Fabric installer -> `fabric-server-launch.jar`;
  Quilt -> installer -> `quilt-server-launch.jar`; Forge < 1.17 and Cleanroom -> runnable jar
  in the root; Forge 1.17+ / NeoForge -> `@user_jvm_args.txt @libraries/.../unix_args.txt`.
- `isLoaderInstallEntry` (instances.ts) defines what a loader install owns (libraries, loader
  and vanilla jars, run scripts, `.fabric`); loader switching and pack changes move exactly
  that aside. Rollbacks only delete what the operation created or moved
  (`removeEntries(dir, test, keep)`) - a failure while moving must never delete originals.
- Java per Minecraft version comes from Mojang's version metadata (`javaVersion`), learned
  before installs/changes and at startup, stored in settings (`java.minecraftRequirements`);
  hard-coded rules in java.ts are only the offline fallback. 26.x needs Java 25.
- Java downloads (`javadownload.ts`): Temurin via `api.adoptium.net/v3/assets/latest/{major}/hotspot`,
  Zulu via `api.azul.com/metadata/v1/zulu/packages` (filter `crac_supported=false`, `os=linux-glibc`;
  `latest=true` still lists one build per update line, so pick the newest; the SHA-256 is only on
  `/packages/{uuid}`). Temurin has no Java 16 JRE (1.17 needs it): JDK fallback. Installed into
  `$DATA/java/<vendor>-<version>-<jre|jdk>/`, which is also a scan root.
- Operations settle Java up front (`planJava`): missing throws `JavaMissingError(major)` before
  anything is created; with `downloadJava` the task downloads it first (`obtainJava`). Forms show
  `JavaPrompt`, whose buttons resubmit the same form with `downloadJava` - so the forms must be
  `use:enhance`d (the new-server ones were plain posts, which lost the picked pack on refusal).
- Cleanroom sets its own Java: <= 0.4.4 -> 21, >= 0.5.0 -> 25 (measured from release jars'
  class-file versions; the Cleanroom wiki's "Java 21+" is stale).

- Loader version lists (`listLoaderVersions`, checked 2026-10-28): NeoForge names builds after
  Minecraft, `21.1.x` for 1.21.1 but year versions whole with a patch, `26.3.0.x` for 26.3 and
  `26.1.2.x` for 26.1.2 (`neoforgePrefix`); some versions have only betas (26.1, 26.1.1, a new
  one's first weeks), and the maven also holds `-alpha.N+snapshot-N` builds, never offered.
  Fabric's meta answers 400 and Quilt's 404 for a Minecraft version they do not have (1.12.2):
  no builds, not an outage. Cleanroom narrows the new-server form to 1.12.2, so leaving it put
  that version on Fabric until the form restored the earlier pick.

## Cleanroom
- Forge 1.12.2 fork; the older installer (0.5.x) takes `--installServer` and leaves
  `cleanroom-<ver>.jar` + `minecraft_server.1.12.2.jar`. Mod catalogs have no Cleanroom tag, so instances query
  them as `forge` (`catalogLoader`).
- **0.6.0+ replaced Mixin with CleanMix**; mods reaching into Mixin internals
  (FermiumBooter) or patching exact targets (Alfheim) crash on it. Forge-pack installs and
  migrations default to the newest 0.5.x; every Cleanroom picker warns on 0.6+.
- The newer installer (0.7.11-alpha's at least; which release changed it is unchecked) has
  modes: `--installServer` is refused ("Unknown option"), `server --dir <path> --version <id>
  --no-gui -y` installs (`-y`: the folder already holds the server's files). It leaves
  `libraries/` (Cleanroom itself as `libraries/com/cleanroommc/cleanroom/<ver>/cleanroom-<ver>-universal.jar`),
  an @argfile `.../<ver>/unix_args.txt`, `user_jvm_args.txt` (with `-Xmx3G`, emptied like
  Forge's), `run.sh` (refuses any Java but 25) and `cleanroom-server.json`. MineShell tries
  `--installServer` first and the mode on "Unknown option". Tried 2026-10-21: a new plain
  server on 0.7.11 installed and booted on Java 25.
- Cleanroom 0.7 asks at the first start when Fugue and Scalar are missing ("These mods are
  missing", `/fml confirm`; forge_early.cfg turns it off). Every Cleanroom server gets both:
  packs moving to it always did, a new plain one since 2026-10-21 (user's call: no reason to
  run without them), with a failure to add one shown in its status, not failing the install.
- `cleanroom.ts`: adds Fugue (Modrinth) and Scalar Legacy (CurseForge, CDN fallback), disables
  a curated must-remove list (never content mods), reports the "replace with fork" list.
  Mods are matched by mcmod.info name/modid and filename because modids lie (Born in a Barn =
  "examplemod", Relictium = "vintagium").
- Fugue >= 0.23.4 needs Java 25; Cleanroom 0.4.x gets the newest earlier build
  (`pickVersionForJava`). Fugue declares `requires cleanroom@[min,)` inside the jar (0.24.x:
  0.6.10, so "newest" broke every 0.5.x server): `pickFugue` downloads candidates newest-first
  and reads it (`inspectFugueJar`); `cleanroomReport(path, version)` lists an installed Fugue
  that does not fit (`replace`), and the fixes, pack installs/changes and Cleanroom version
  changes swap it (old one disabled only once the new one is in).
- Migration keeps Forge in `.mineshell/forge-backup/` with a manifest; revert restores it all.
- Fugue 0.21 rewrites other mods' `getURLs()` calls into `com.cleanroommc.hackery.ReflectionHackery.getURL`,
  which Cleanroom 0.5.3 removed (0.23.x has its own `HookHelper.getURL`); the crash shows only
  the patched mod (Quantum Things), never Fugue. Cleanroom <= 0.5.3 keeps `Style.getFormattingCode`
  client-only, which AvaritiaItem calls while loading. So MeatballCraft 0.18.4-hotfix6 (ships
  Fugue 0.21) runs on no Cleanroom as shipped; 0.5.17 + Fugue 0.23.4 works (production, 2026-10-11).
  Checked on the release jars (binpatches applied to the vanilla server jar).

## Forge's startup questions
- `forgequery.ts`: Forge < 1.13 and Cleanroom ask on the console (missing registry entries,
  missing registries, backup level.dat) and read only stdin; units have none, RCON is not up
  yet. Answered by starting once with `-Dfml.queryResult=confirm` via `<id>.once`, which the
  template's start command reads and deletes (Type=simple: a one-off in `.env` would race).
  Tried end to end on a throwaway dev server with a fake java printing MeatballCraft's
  question: detected from the real journal, snapshot + start with the flag, Stop, and a restart
  asked again. On a real Forge 14.23.5.2859 server (2026-10-15, Biomes O' Plenty removed: 371
  entries) the question's lines spread over 5 ms, so `readMessageAt` reads the seconds before
  the prompt; confirm, snapshot, boot and a flagless restart all worked.

## Minecraft version / loader migration
- `migrate.ts`, Settings > "Minecraft version and loader" (not for pack servers, which move
  with the pack, nor Cleanroom). Only upward Minecraft moves (a newer world does not load in
  an older version). Mods that MineShell can look up move to the target's best build (release
  first) plus required dependencies (`resolveDependencies` with the target's filter); ones
  without a build, and untracked jars, are disabled (user's call, 2026-10-08). Disabling
  stages the original and copies it back as `.disabled`, because the shared restore deletes
  every mods/ file that was not there before. Journal `migrate` (mods + rows + loader).
- The free-text Minecraft version field is gone: it only relabelled the server.
- Tried for real on the throwaway setup: vanilla 1.21.1 -> Fabric 1.21.4 through the UI;
  and 2026-10-15 Fabric 1.20.1 with four Modrinth mods -> 1.21.1 (Starlight disabled, three
  updated, snapshot), booted on the upgraded world.

## Client-only mods
- `clientonly.ts` runs after pack installs/changes on the jars they added: Modrinth
  `environment` containing `client_only` (by hash), or a Fabric/Quilt client environment ->
  disabled unless an enabled mod requires it. Flag lives on `instance_mods.client_only`, not
  on `mods`: manual mods share a `mods` row by file name.
- Modrinth's `environment` is a list (`["client_only"]`), not a string.
- The worst offenders declare nothing: Missing Mods Checker's fabric.mod.json says
  `"environment": "*"` and crashes headless servers (Swing). Only Modrinth's metadata knows.
- A mods.toml's dependency blocks have `modId=` lines too; a jar's own ids come from
  `[[mods]]` blocks only.

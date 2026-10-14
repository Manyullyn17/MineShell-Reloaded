# Item check

Names and pictures of every item, as the player editor shows them, for vanilla versions
and real servers. A manual check, not part of `npm test`: it downloads Minecraft client jars
and minecraft-data's item lists, and reads real servers' mods and worlds (read only).
`flows/itemicons.test.ts` holds the regression tests for what it found.

## Run

```sh
npm run check:icons                                   # vanilla 1.12.2 ... latest, names and pictures
npm run check:icons -- --render                       # also draw every picture in headless Chromium
npm run check:icons -- --vanilla 1.12.2,1.21.1 --sheets
npm run check:icons -- --instance ~/mineshell-data/instances/meatballcraft-cleanroom@1.12.2 --world --render
npm run check:icons -- --instance <server folder>@<version> --baseline <earlier report folder>
```

| Option | What |
|---|---|
| `--vanilla <v,v,...>` | Versions to check (`latest` = today's release, `none` = no vanilla). Default: one per code path from 1.12.2 to the latest; none when `--instance` is given |
| `--instance <dir>@<version>` | A server folder (repeatable). Its items: Forge's registry on 1.12, the picker's list on 1.13+ |
| `--world` | Also every item stack in the server's world (regions, entities, player files): the variants that occur. MeatballCraft's 2.7 GB world takes about 5 minutes |
| `--render` | Draw every picture with the page's own renderer (`lib/shared/itemicon.svelte.ts`) in headless Chromium, counting what draws nothing |
| `--sheets [problems\|all]` | Contact sheets, 100 a page: the problems (guesses on a yellow tile, pictures that draw nothing) or every item. Implies `--render` |
| `--out <dir>` | Where the report goes (default `~/.cache/mineshell-itemicons/reports/<time>`) |
| `--baseline <dir>` | An earlier report: lists items that lost or gained a picture, were renamed or are drawn differently. Exits with 2 when any lost one |

Chromium: `$CHROME`, else Playwright's under `~/.cache/ms-playwright`, else `chromium` /
`google-chrome` on the PATH (`npx playwright install chromium-headless-shell` gets one).

## What it reports

Per target: items, no picture, pictures that draw nothing, pictures with missing texture
files (usually a mod's textures for a mod that is not installed), guessed pictures, names
taken from the id because no lang key was found; for vanilla also names unlike
minecraft-data's and the picker's missing and non-item entries; for a server a table of the
mods with the most items without a picture, and with `--world` the share of the world's
stacks without one. `<target>.json` in the report folder has every item: name, where the
name came from, the picture spec, guess flag, missing textures, drawn pixels.

minecraft-data's names are its own in places, not the game's: it calls 1.12's planks
"Wooden Planks" where the game says "Oak Wood Planks" at damage 0, music discs "13 Disc"
where the game says "Music Disc" (the disc's name is the tooltip's second line). Check a
difference against the version's lang file before calling it a bug.

## How it works

`check.mjs` loads `check.ts` through Vite with the repo's config, so it runs MineShell's own
code (`iconsFor`, `itemName`, `itemChoices`), against a data folder of its own
(`~/.cache/mineshell-itemicons/data`, client jars kept between runs). It refuses a real
MineShell data folder or one with servers in it. Item lists for vanilla come from
[minecraft-data](https://github.com/PrismarineJS/minecraft-data) (with 1.12's damage
variations); a version it does not have yet is checked against the jar's own items.

1.12 items are asked for with damage 0 when they have none, as the page sends them.

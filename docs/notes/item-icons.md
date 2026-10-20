# Item icons and names

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Item icons
- `itemicons.ts` resolves (index of models/items/textures/blockstates over mod jars + the
  cached client jar), `lib/shared/itemicon.svelte.ts` draws in the browser (canvas, affine
  face mapping, painter's order, faces chosen by the model's display.gui rotation). The game's
  y rotation is a quarter turn off the projection: yaw = rotation[1] - 90. Blocks 225 (furnace
  front on the left), stairs 135 (tall half back right) - the user checked both; a sign flip
  fits blocks but not stairs. Icons keep a margin (flat 7/8, a full block ~4/5 wide): the
  user found edge-to-edge too big and slot-relative sizing too small on a phone. The picture
  fills a square slot inside its border (32px on a phone, 58px in a desktop's 60px slot;
  `container-type: size` + `cqw`, 32px floor): a fixed 32px was half a desktop slot.
- Tooltip and desktop item lists only where `(hover: hover) and (pointer: fine)` matches
  (JS for the tooltip, CSS for the slots). Headless Chrome answers false to both and
  ignores Emulation.setEmulatedMedia for hover: tests override matchMedia and flip the
  CSS rule's media text. `hovered` is $state.raw (a proxy broke the identity check).
- Names (`itemName`): 1.12 registry ids are lower case while keys keep camel case
  (botania:manaringgreater = item.botania:manaRingGreater.name), so keys also match ignoring
  case; .lang keys escape colons (`item.ebwizardry\:charm_flight.name`); some ids carry
  `item.` (projecte:item.pe_life_stone). A pack's own asset folders (`resources/` for
  ResourceLoader/ContentTweaker, `kubejs/assets/`) are indexed before the mods and override
  them; lang files merge key by key, as in the game. MeatballCraft: 16089 of 20494 items
  named from the id before, 13350 after; most of the rest are damage variants.
- 1.12 variants get names from the variant the icon lookup picked (`variantOf`: the
  blockstate's value or the model's name): `tile.<ns>.<variant>.name` and friends, or under
  the id (`item.thermalfoundation.material.dustPetrotheum.name`). Same guess as the icon:
  the n-th value for damage n, which most mods follow but nothing guarantees.
- `Resources.lang()` is read once and kept (a big pack: ~100k lines); per call it made 500
  icons take 20 s, and run side by side it took the server past its 4 GB heap. A batch's
  icons resolve side by side. Closed item sections render (and ask for icons) once opened.
- Picker: `itemChoices` (1.12: level.dat FML registry minecraft:items; newer: items/
  definitions, else models/item minus base models), names via `itemName` (lang keys).
- Vanilla chests (chest, trapped, ender) are drawn in the game's code (builtin/entity; 1.21.4's
  special `minecraft:chest` model): `chestSpec` builds base, lid and latch on the 64px entity
  texture by the game's box layout. 1.15 flipped those textures (jars with
  `entity/chest/normal_left.png`); the renderer mirrors a uv given backwards. Checked by eye
  on 1.12.2 and 1.21.4.
- 1.12 mods that pick models in code: an item model in a subfolder found by file name when
  only one has it (aoa3 models/item/weapons/bows/...), then a texture numbered by damage
  (from 0, or 1 when the series starts there: klein_star_6 = Klein Star Omega, damage 5;
  handybag_1), flagged; a plain texture beside the numbers means frames, not variants. The
  numbered name names the variant too (item.pe_klein_star_6.name). MeatballCraft at damage 0:
  items without a picture 4792 -> 3518.
- Name keys: the mod's own (`tile.<ns>.<id>`) before bare ones (`tile.chest.name` is vanilla's
  chest, not AE2's). Mods override vanilla's keys as in the game (Railcraft's "Track").
  1.12 vanilla ids whose key does not follow the id are in `VANILLA_112_KEYS` (read from the
  1.12.2 jar's Block/Item registration bytecode: gold_block = tile.blockGold, beef =
  item.beefRaw; `tile.stonebrick.name` is cobblestone's key). Vanilla 1.12
  variants are named from `VANILLA_112_NAMES` (damage -> key: stone 1 = tile.stone.granite,
  planks = tile.wood.*, wool = tile.cloth.*; dye and banners count colours from black),
  checked against the 1.12.2 jar's en_us.lang. Lang values that are templates the mod fills
  in code ("%1$s Dust") show their gaps as "…"; one that is only gaps
  (crafting_on_a_stick's "%1$s%2$s%3$s") counts as no name (`filled`).
- Shulker boxes (`shulkerSpec`): ShulkerModel's lid (16x12x16 at 0,0) and base (16x8x16 at
  0,28), the base set back 0.05 so the lid's holed lower rows are in front of it; textures
  `entity/shulker/shulker[_color]` (1.12: `silver`; no undyed box). 26.x model textures can be
  `{ sprite, force_translucent }` (glass): loadModel takes the sprite. A `select` on display
  context takes its `gui` case (trident). Shield (`shieldSpec`): ShieldModel's plate and handle,
  `entity/shield_base_nopattern` (26.x: `entity/shield/`); its turn (220) was matched to the
  user's in-game screenshot - the projection's quarter-turn rule (blocks, chests) gave the
  wrong side for it.
- Code-drawn items (`entityicons.ts`): the game's model parts (read from the 26.3 client with
  javap: texOffs, addBox, PartPose; 26.x item definitions' `transformation` is the placement)
  become quads with ModelPart.Cube's exact corner/uv assignment (mirror swaps min/max x), sent
  as `quads` with a box `group`; the renderer draws boxes back to front as wholes (a face's
  middle put a chest's lid over its latch). Chests, heads (no yRot for items), banners (plain:
  base layer tinted by dye colour), beds (pre-26.x BedRenderer), conduit, decorated pot,
  copper golem statue (standing). Turns matched to the user's in-game screenshots: banner 70,
  bed 220 (user picked from seven), statue 225, shield 220 - the item models' own rotations do
  not map onto this projection for code-drawn models. `scale` = gui scale / 0.625.
- Checked end to end 2026-10-14 with `npm run check:icons` (tests/itemicons/README.md): vanilla
  1.12.2-26.3 all items pictured and named; MeatballCraft 18% of registered items without a
  picture (9.5% of the world's stacks), ATM10 3%. Lookup order for a mod item without damage:
  its item model, then its blockstate (the placed block), then dotted ids as folders, nested
  blockstates, nested models, numbered textures. 1.12 lookups ignore case (the game
  lower-cases). The loader's own universal jar (libraries/) is indexed after the mods.
  Composite models (children with a `transform` left out) and NeoForge fluid buckets (fluid
  texture found by name, else the empty bucket flagged) are drawn. Pre-1.21.4 vanilla tints
  (eggs, leather, potions, leaves) are `LEGACY_TINTS` (itemtints.ts, from 1.21.4's
  definitions). Names: last resort before the id is a key in the item's own mod's lang file
  with the same words (`byWords`). Open (user's call: decide later): 1.12 mod damage variants
  whose model names only the mod's code maps (AE2 material/part, IE metal, Botania
  manaresource) - the bulk of what is left on 1.12.
- 1.7.10 (checked 2026-10-14 on a throwaway Forge 10.13.4.1614 server with 24 classic mods,
  booted once with a Temurin 8 JRE to write level.dat): no item models before 1.8, so vanilla
  pictures use 1.8.9's models over the version's own textures (`modelless` Resources); mod
  items by `textureByWords` (items flat; blocks as cubes, guesses, only before 1.8). 1.7 ids
  keep capitals and '|' (BuildCraft|Core), assets are lowercase without '|' (`domain()`),
  mods' asset folders come from mcmod.info (TConstruct -> tinker); IC2's names are in
  `ic2/lang/en_US.properties` outside assets/. Result: vanilla 340/340 pictured, the mod server
  52%. Player page seen in headless Chrome (CDP; `--screenshot` fires before the page draws).
- Item pictures can be turned off (MineShell settings > System, `itemicons.enabled`): the icon
  endpoint then answers empty and the player page asks for nothing.
- Without the EULA answer Minecraft's base models (item/generated, block/cube_all ...) come
  from BASE_MODELS (shapes only), so mod items still get pictures.
- 1.12: vanilla variant table VANILLA_112 ("silver", dye reversed); Forge blockstates
  (forge_marker; variants by property or listed directly; "cube_all" = minecraft's;
  forge:item-layer = flat). Guesses flagged; plain item model + damage = wear, not flagged.

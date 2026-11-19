# MTGClownfish handoff notes

Where the project stands and how to work on it: read this first when picking the project back up. Last updated
2026-11-18, evening (branch `online-play`, 33 commits ahead of `main`, nothing pushed). Next session: more VFX,
plus sound effect and music upgrades (see "Starting points for the next session").

## What it is

A desktop Magic: The Gathering table. A 3D, Arena-style client (Three.js) plays against Forge's rules engine and
AI, either 1v1 or 4-player Commander. Friends can join online through a relay. It ships as **MTGClownfish.app**
(Apple Silicon and Intel) and **MTGClownfish.exe** (Windows), each with its own trimmed Java runtime.

```
client/    Three.js table + HTML HUD (TypeScript, Vite). Built into the package; the bridge serves it
bridge/    Java WebSocket bridge: runs Forge headless, sends JSON state/prompts, takes clicks back
engine/    forge/ is a plain clone of Card-Forge/forge (git-ignored). patches/ holds our fixes to Forge itself
relay/     Cloudflare Worker + Durable Object per lobby: lobby codes, message passing, serves the web client
desktop/   Electron shell: starts the bridge hidden (bundled Java), shows the game, stops the engine on quit
scripts/   build-engine.sh, package.sh, play.sh (dev), smoke-test.mjs
docs/      this file, arena-reference.md (camera/layout measurements from Arena)
```

## Build, run, package

| Task | Command |
|---|---|
| Build Forge + bridge (also applies `engine/patches/*.patch`) | `scripts/build-engine.sh` |
| Dev: bridge + Vite client in the browser | `scripts/play.sh` (bridge on ws 7777, client on 5173) |
| Headless full game | `node scripts/smoke-test.mjs commander 4` (needs a running bridge on 7777) |
| Desktop packages (zips into `dist/`) | `scripts/package.sh` for all three; `scripts/package.sh mac-apple-silicon` (or `mac-intel`, `windows`) for some. Must run on an Apple Silicon Mac |
| Client type check / build | `cd client && npx tsc --noEmit && npx vite build` |

- **Forge version.** The bridge pom defaults `forge.version` to a stale 2.0.16. Always build against the version
  Forge declares, which is what `build-engine.sh` does. If you rebuild only the bridge by hand, pin it:
  `REV=$(ls ~/.m2/repository/forge/forge-gui | grep SNAPSHOT | sort -V | tail -1); cd bridge && mvn -q -B package -Dforge.version="$REV"`.
  Building against the old version runs October's engine against today's card scripts, and some cards crash game
  setup (Dragon Whelp: "EndOfTurn not found in ApiType").
- **Updating Forge.** `git -C engine/forge fetch && git -C engine/forge merge --ff-only origin/master` (it's a
  shallow clone; `rev-list --count` is meaningless, count by date instead), then `scripts/build-engine.sh`, the
  smoke test and the dev-mode checks below. Last updated to `d9ae661` (2026-11-18).
- **Engine patches** (`engine/patches/`): applied in order by `build-engine.sh`, once per checkout. A patch that
  no longer applies stops the build. Current patches:
  - `0001-total-mana-symbols-exile-cost.patch`: exile costs with "N or more mana symbols of a colour among the
    chosen cards" (Baron Helmut Zemo) can be paid. Adds a running count to the picker and holds OK until the
    total is met.
  - `0002-baron-helmut-zemo-copies-this-activation.patch`: card script, `Defined$ ExiledCards` (only this
    activation's exiled cards, as they are in exile; `Exiled` is the pre-move LKI and gets dropped by PlayEffect,
    `ExiledWith` is every card ever exiled with Zemo).
  Prefer fixing in the bridge when possible; patch Forge only for bugs the bridge can't reach from outside.
- **Packaging gotcha.** A Finder window open on `dist/` writes `.DS_Store` files back while folders are being
  deleted. `package.sh` retries the deletion, but closing that window avoids the problem.
- **Rebuilding for the user:** "rebuild" means the Apple Silicon app only (`scripts/package.sh mac-apple-silicon`).
  Build all three only when asked for new distributables. Don't quit their running app to relaunch it; tell them to
  reopen it. When they ask to try a change first, point them at `scripts/play.sh` and http://127.0.0.1:5173/.
- **"Wants access to your Documents folder" on launch:** the app run from `dist/` lives under `~/Documents`, and
  its bundled Java reads Forge's data from inside the bundle. Ad hoc signing means each rebuild is a new app to
  macOS, so it asks again. Running a copy from `/Applications` should stop it (inferred, not yet confirmed by the
  user). A Developer ID signature would make the answer stick across rebuilds.

## How the pieces talk

- **The bridge's view of a player** is `SocketGuiGame` (Forge's `IGuiGame`). It turns state into JSON updates
  (`Serializer`), sends prompts (`ok`/`cancel` buttons, `input` = Forge input class, `selection`), and asks
  questions as `request`s (`choose`, `confirm`, `order`, `input`, `reveal`, `distribute`).
- **`BridgeHumanPlayer.Controller`** (a `PlayerControllerHuman`) holds the human-side hooks:
  - `chooseSpellAbilityToPlay()` runs on the game thread at every priority. It decides whether auto-pass may skip
    (Forge's own "anything to do?" scan undercounts), and it offers Zemo's boast.
  - `playChosenSpellAbility()` refuses abilities whose costs can't be paid.
- **The client:**
  - `main.ts` routes messages and wires handlers.
  - `game/table.ts` holds card objects, the update pipeline and animations.
  - `scene/` holds the 3D side: `stage.ts` (renderer, frame governor, floor shader, post passes, embers),
    `cardMesh.ts` (card, badges, token tag, dissolve), `fx.ts` (sparks, arrows), `magic.ts` (sprite spell effects),
    `spotlight.ts` (commander cast), `collapse.ts` (a lost player's mat), `layout.ts`, `textures.ts`.
  - `ui/hud.ts` holds all HTML UI: prompt, buttons, The Stack, zoom, dialogs, menus, Settings, player badges.
  - `ui/decks.ts` is deck setup, `ui/lobby.ts` is online play, `ui/buildin.ts` the menus' build-in/out helpers.
  - `audio.ts` synthesizes every sound and the music bed (see "Starting points for the next session").
- **The client's card cache:** each update sends only the cards still in play; the client merges them over the
  last known copies, so a card that stops existing keeps its last report. A card missing from every zone list is
  kept where it is while its last zone says it's between zones, except tokens (copies count), which go at once.
- **Dev mode** (`java -Dbridge.dev=true …`): the client message `{type:'devState', text}` applies a Forge
  GameState to the running game. Keys:
  - `humanbattlefield=Card|Counters:P1P1=2|Id:900;…`
  - `humangraveyard=…`, `humanexile=Card|ExiledWith:900`
  - `aiputonstack=Wrath of God;…`
  - `t:Name,P:2,T:4,Cost:…,Types:Creature-Zombie,…` (a token)
  - `activeplayer=human`, `activephase=MAIN1`
  - `humancommand=Card|IsCommander` makes a commander. `humanlibrary=…` sets a library (set one for every
    player, or the next draw loses the game).
  - More than two players: `p0life`…`p3life`, `p0battlefield`, etc. (`human`/`ai` are p0/p1). After someone
    loses, the indices renumber over the players still in (a board naming four players in a three-player game
    throws "Non-matching number of players").
  - **Always** set every player's life (a player left out gets -1 and loses). Life 0 makes that player lose,
    which is the easy way to test a loss.
  - Apply it only once you have priority, not during the mulligan, and not mid-combat (one applied during an
    attack declaration left Forge with no defender). Several boards in one game can leave stale state: start a
    fresh game for a clean test.

## Testing recipes that worked

- **Protocol-level scenarios (node).** Open `ws://127.0.0.1:<port>` and send `{type:'start', format, players}`.
  Answer `request`s, and press OK until the prompt's `input` is `InputPassPriority` with your priority. Then send
  `devState`, and drive with `{type:'action', action:'ok'|'cancel'|'card', id}`. Run the bridge on a spare port
  (`-Dbridge.port=7790 -Dbridge.logs=<dir>`). Read results from the game log under `bridge.logs`.
  - Pace clicks: allow about a second between picks, or you'll read updates that haven't caught up.
  - Decide the phase from the prompt text (e.g. "postcombat" and OK enabled), not from `state.phase`, which runs
    ahead of the prompt.
- **Real client in headless Chrome (CDP).** Build the client with `--outDir <dir>/new --base /new/` and serve
  `<dir>` with `python3 -m http.server`. Copy `client/public/table-floor.jpg` and the logos to the server root.
  Open `index.html?bridge=7790`.
  - Launch `Google Chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<fresh>` and drive it
    over CDP from node (`Runtime.evaluate`, `Input.dispatch*`, `Page.captureScreenshot`).
  - The debug port is sometimes on `127.0.0.1`, sometimes on `[::1]`: try both.
  - A fresh profile can take 30–60 s to start.
  - Headless starts CSS animations late, so pause them and step through instead:
    `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t })`.
  - In zsh, `set -- $var` doesn't split words: pass numbers explicitly.
  - Without the Chrome extension, `--headless=new --screenshot` works for static pages, but it catches CSS
    fade-ins midway.
  - Three.js animation can't be paused like CSS: take bursts of screenshots ~120–300 ms apart instead.
  - Hover goes through raycasting, so send real mouse moves (`Input.dispatchMouseEvent` `mouseMoved`), not DOM
    events. HTML hovers (badges) do respond to a dispatched `mouseenter`.
  - Capture the game socket by wrapping `WebSocket.prototype.send` in `Page.addScriptToEvaluateOnNewDocument`;
    then `devState` and actions can be sent from the page, and its messages read.
  - Dialog option cards are `.choice-cards .thumb` buttons; prompts' buttons are found by their text.
- **A bridge driver over HTTP** (one node process holding the socket, taking `?send=`/`?card=`/`?ok`/`?req=`
  queries and printing the prompt, selectable cards and zones) made long scripted scenarios easy to step. Use
  `curl -g`, or curl treats `[0]` in a URL as a pattern and sends nothing.
- **Performance.**
  - Most reliable measure: `ps` CPU of all Chrome processes with the game in a throwaway `--app` window.
  - macOS GPU "Device Utilization" (`ioreg -c IOAccelerator`) is only a rough guide (it's relative to the GPU's
    current clock).
  - Bridge: `ps`, `jstack` samples, `jstat -gcutil`.

## Conventions

- **Commits:** one long, plain-English paragraph saying what changed for the player and why, ending with the
  `Co-Authored-By` line. Commit only when asked, on `online-play`, and never push without being asked.
  `New Design Reference/` and `client/public/clownfishlog.png` stay untracked.
- **YAGNI:** make the smallest change that does the job, verify it in a real run (screenshots, scenario
  scripts), and report what was and wasn't verified.
- **Design:**
  - The look lives in `theme.css` (the "arcane arena" redesign: slate panels, gilt rims, arcane blue/violet
    highlights). `style.css` keeps layout and behaviour.
  - **Alegreya is the only typeface:** `var(--display)` in CSS and `CANVAS_FONT` for text drawn on canvases.
    Numbers use lining figures page-wide. Canvas text can't, but Alegreya's digits read fine on badges.
  - Respect `prefers-reduced-motion`.
- **Settings** (`client/src/settings.ts`, saved in localStorage) cover frame rate, effects, table detail and
  resolution. The renderer reads them every frame or subscribes with `onSettings`.

## Notes for VFX work

- **three.js is r186** (0.186.1), the version the installed `threejs-*` skills are written for: load the matching
  skill before effect work (`threejs-shaders`, `threejs-postprocessing`, `threejs-performance`,
  `threejs-geometry`, `threejs-textures`, `threejs-materials`, `threejs-animation`). The client is WebGLRenderer
  + GLSL, so the skills' WebGPU/TSL sections don't apply. The stage clock is `THREE.Timer`; shadows use
  `PCFShadowMap`, which honours `shadow.radius`.
- **Post passes:** RenderPass → UnrealBloomPass (threshold 1.02) → the hit pass (colour split on blows, plus the
  spotlight vignette: `stage.hitPulse`, `stage.setSpotlight`; it runs only while either shows) → OutputPass.
  Then the overlay layer is drawn untouched.
- **Bloom:** anything above ~1.0 glows and spreads. Keep broad surfaces (magma, light sheets) below it and let
  only thin peaks cross it, or a whole area washes out (both effects today needed toning down for this).
- **Per pixel, not per vertex:** values interpolated across mesh triangles show the triangles (stair-stepped
  edges). Work out anything with a visible edge in the fragment shader; the collapse shares one GLSL block
  between both stages for this. Use gradient noise, not value noise, for anything seen up close, and
  `fwidth`-based smoothsteps for anti-aliased edges.
- **Matching the floor:** `stage.floorUniforms()` shares the floor painting's uniforms by reference, and
  `FLOOR_RING_V` maps world positions onto it, so an effect can draw the battlefield exactly as it is.
  `stage.setFloorHoles()` stops the floor drawing inside boxes (for anything that goes below it). The mats'
  lava palette is `TINT = vec3(1.0, 0.3, 0.04)` with a white-hot peak.
- **The commander spotlight** (`spotlight.ts`): an additive shader plane in the camera rig (main pass, so it
  blooms) behind a card held on the overlay layer at `SPOT_POS`/`SPOT_SCALE`, plus the vignette. A pattern for
  other "hold a card centre stage" moments.
- **The collapse** (`collapse.ts`): a gsap timeline drives uniforms, shakes, sounds and particle bursts over
  `COLLAPSE_SECONDS`; the table awaits it, and `table.settled()` lets the game-over screen wait for it.

- **Particles:**
  - New emitters should gate each emission with `particleAllowed()` (it handles Full/Reduced/Off).
  - Keep a live count and register `stage.onBusy(() => live > 0)`, so Auto frame rate runs at 60 fps while they
    animate.
  - Skip per-frame work when nothing is alive (see `fx.ts` and `magic.ts`: `live`/`cleared`).
- **Animation:**
  - Anything animated outside gsap and particles should call `stage.wake()` while it moves.
  - gsap tweens are detected automatically (`gsap.globalTimeline.getChildren`). Don't add infinitely repeating
    tweens, or Auto will never drop to 30 fps.
- **Shaders:**
  - The floor shader (`stage.ts` `buildTable`) has a `LOW_DETAIL` define for Table detail: Low, plus early-outs
    (fully painted floor, more than 3.6 units from every mat edge) that keep High identical but cheaper.
  - New heavy shaders should get a Low path too.
- **Shadows:** redrawn only on frames where something moves (`shadowMap.needsUpdate`), plus a slow idle
  refresh.
- **Overlay pass:** hand, stack and command-zone cards render in `OVERLAY_LAYER` after post-processing, so
  their art keeps its true colours. Meshes attached to those cards must switch layers too (see `setSpace`).
- **Measuring cost:** at idle, the main menu ran at about 21% Chrome CPU on an M5 Max (55% before this
  session's work), and about 22% in-game. Not re-measured after today's effects (they cost nothing at rest:
  hidden, or a static scar).

## Starting points for the next session (VFX, sound effects, music)

- **Audio today** (`client/src/audio.ts`, `sfx`): everything is synthesized with Web Audio, with no audio files.
  `tone()` (oscillator with glide, vibrato, attack) and `noise()` (filtered noise burst) feed an sfx bus and a
  shared convolver reverb (`impulse()`), with stereo pan from the table position. `begin(name, gap)` rate-limits
  each sound. The "music" is `startAmbient()`: a low pad with a breathing filter and occasional shimmer on its
  own bus (Sound menu: effects and music on/off, volume; saved in localStorage).
- **Sounds added today:** `commander` (swell), `thunk` (commander landing), `rumble`, `collapse`, `sizzle` (the
  lava collapse).
- **Options to raise for music:** a richer generative score (chord progressions per colour, turn/phase-aware
  intensity, a victory/defeat sting), or licensed/recorded tracks as files (the packages would carry them;
  Forge's own `res/music` is excluded from packaging today).
- **VFX candidates:** effects for other big moments (a player winning, extra turns, board wipes, planeswalker
  ultimates), more per-colour spell effects, and the Low-detail paths for anything heavy.

## Work done on 2026-11-17/18 (newest last)

1. **New logo:** the clownfish crest on the start and join screens (`logo-large.webp` / `logo-360.webp`), plus
   app icons.
2. **Priority prompt:** OK reads "Pass Priority", and Forge's duplicate "End Turn" button is hidden.
3. **Bounce lands:**
   - Their "return a land" trigger could be dropped by answering No to a misleading "already played a land, use
     … instead?" question.
   - That question is now only asked for real clicks (`getAbilityToPlay` with a non-null trigger event).
4. **Forge updated** to `d9ae661`. This made Star Trek, the newest Commander-legal set, nearly fully playable.
5. **Hover zoom in dialogs:** the zoom shows above dialogs and the card browser, which leave room for it.
6. **Performance:**
   - Frame-rate governor: Auto is 60 fps while moving and 30 when still.
   - Floor-shader early-outs, shadows on demand, idle particle skip.
   - New **Settings** dialog (main-menu chip, and in-game next to Sound).
7. **One typeface:** Inter and Cinzel removed everywhere, including canvas text on cards.
8. **The Stack:**
   - Twice the size, and kept clear of the prompt (it rides up, then shrinks its cards on short windows).
   - **›** or **S** tucks it into an edge tab, which pulses when something is added.
   - Hovering a stack card shows the zoom on the left.
9. **Token tag:** a "Token" tag on tokens, and a Token chip in the zoom.
10. **Deck import:** lines naming a printing Forge lacks (promo sets, Summer Magic, missing reprints) are retried
    by name instead of being dropped.
11. **Baron Helmut Zemo:**
    - The boast is payable (patch 0001).
    - You're asked after he attacks, and the graveyard opens in the card browser.
    - Copies come only from this activation's exiles (patch 0002).
12. **Build script:** the version fallback picks the newest Forge in the Maven cache.
13. **Start screen build-in/out** (crest, tagline, staggered cards, chip: 1.3 s in, about 0.28 s out).

## Work done on 2026-11-18, evening (newest last)

1. **three.js r170 → r186**, to match the installed skills. `Clock` → `Timer`, `PCFSoftShadowMap` →
   `PCFShadowMap`. Compared side by side with an r170 build: identical apart from noise.
2. **Copies that ceased to exist stayed on the table** (a resolved copied Entomb, a sacrificed copy of Doomsday
   Excruciator from Zemo's boast): tokens missing from every zone now leave whatever their last report said.
   The bridge can still report a resolved copy's zone as Stack while it's on the battlefield; the client no
   longer depends on it, but that bridge quirk itself wasn't fixed.
3. **Menu build-ins** for the game setup screen and its dialogs (deck picker, precon browser, pasted lists,
   gameplans, API key), in the start screen's manner.
4. **The Stack with one item** wraps its text under the card (at least 340px wide) instead of stretching across
   the table.
5. **Commander spotlight:** once a commander's cast is paid for, it rises centre screen for 1.5 s with a
   waterfall of light in its colours and a darkened, tinted fringe, then lands with a thunk, slow-motion beat and
   shake. Any player's commander (it replaces an opponent's cast reveal); off with Effects off.
6. **Commander art on player badges** (inside opponents' medallions, partners split; across your own panel),
   hover for the card.
7. **Pass Turn at the declare attackers step** works: it calls back picked attackers (only when the button says
   "Call Back", never Alpha Strike), confirms no attack, then passes the turn. The Stack panel now sits above
   badges (below dialogs and the zoom).
8. **A losing player's mat collapses into magma** (4 s): cracks, falling plates, flood, cooling into a scar of the
   battlefield's own painted ground with a few molten fissures. The scar stays; the game-over screen waits.
   Reworked once after feedback (pixelated lava, a scar that didn't match the terrain).
9. **The hand is 15% larger** (a full hand spans no wider than before).
10. **Your commander grows in place on hover** instead of opening a duplicate zoom.
11. **Reveals show cards, not text labels:** cards from a hidden hand used the table's face-down copy; face-down
    cards being revealed now show their real face (reveals only, never target choices).
12. **`scripts/package.sh` takes platform names.** All three packages built from `5730641`.

## Open items

- **Zemo, casting copies during combat:** the user expected the copies to be held to normal timing. Casting
  during an ability's resolution ignores card-type timing (same rule as cascade), so this was not changed. Revisit
  only if an official ruling says otherwise.
- **Not verified:**
  - A face-down card being revealed (code path only; no easy dev setup).
  - The Intel and Windows builds on real machines.
  - The commander landing's shake and slow-motion beat, and all the new sounds (still frames can't show them;
    the user tested the build and was happy with it).
  - The Stack tab's pulse when something is added while it's tucked.
  - The token tag's readability from the 4-player view.
  - Performance on Windows.
  - Very small windows (about 750×470): the Stack and the prompt can't both fit; tucking the Stack clears it.
- **Small body text:** Alegreya's x-height is smaller than Inter's, so 13px blurbs (e.g. main-menu card
  descriptions) read a bit small. The Settings hints went to 14px; the user hasn't decided on the rest.
- **Upstream Forge AI:** its look-ahead (`FlatMonteCarloPicker`) logs "rollout failed … using the heuristic
  choice" now and then (seen with Nalia de'Arnise). It falls back safely; report upstream if it becomes frequent.
- **Commander bans:** the next announcement is expected 2026-11-30. Forge's `formats/Casual/Commander.txt`
  matched upstream as of 2026-11-18.
- **Design hook:** it flags an "overused font" when Inter appears. Inter is gone now, so it shouldn't fire.
- **Your own panel's commander art** still opens the zoom on hover (useful once the commander is on the
  battlefield); the user may want it to match the in-place hover of the command-zone card.
- **The victory screen reads "You wins"** (the winner's name is "You"); worth a grammar fix.
- **Dev only:** the badges remember every commander seen, so swapping commanders with dev boards shows stale
  ones (real games can't change commanders).

# MTGClownfish handoff notes

Where the project stands and how to work on it: read this first when picking the project back up. Last updated
2026-11-18 (branch `online-play`, 25 commits ahead of `main`, nothing pushed).

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
| Desktop packages (all three zips into `dist/`) | `scripts/package.sh` (must run on an Apple Silicon Mac) |
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
- After each set of committed changes, the user expects the packages to be rebuilt, then a check that the zip
  contains the change (e.g. grep the Windows zip's client JS, or `cmp` its `forge-bridge.jar` with `bridge/target`).

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
  - `scene/` holds the 3D side: `stage.ts` (renderer, frame governor, floor shader, embers), `cardMesh.ts` (card,
    badges, token tag), `fx.ts` (sparks, arrows), `magic.ts` (sprite spell effects), `layout.ts`, `textures.ts`.
  - `ui/hud.ts` holds all HTML UI: prompt, buttons, The Stack, zoom, dialogs, menus, Settings.
  - `ui/decks.ts` is deck setup and `ui/lobby.ts` is online play.
- **Dev mode** (`java -Dbridge.dev=true …`): the client message `{type:'devState', text}` applies a Forge
  GameState to the running game. Keys:
  - `humanbattlefield=Card|Counters:P1P1=2|Id:900;…`
  - `humangraveyard=…`, `humanexile=Card|ExiledWith:900`
  - `aiputonstack=Wrath of God;…`
  - `t:Name,P:2,T:4,Cost:…,Types:Creature-Zombie,…` (a token)
  - `activeplayer=human`, `activephase=MAIN1`
  - **Always** set `humanlife`/`ailife`, or both players are set to -1 life and the game ends.
  - Apply it only once you have priority, not during the mulligan.

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

## Notes for the coming particle / shader work

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
  session's work), and about 22% in-game.

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
    Committed with these notes.

## Open items

- **Zemo, casting copies during combat:** the user expected the copies to be held to normal timing. Casting
  during an ability's resolution ignores card-type timing (same rule as cascade), so this was not changed. Revisit
  only if an official ruling says otherwise.
- **Not verified:**
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

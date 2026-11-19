# MTGClownfish

A local, single-player Magic: The Gathering table with an Arena-style 3D client and Forge AI opponents.
No store, no deckbuilding, no networking: you play against the AI, 1v1 or 4-player Commander.

```
client/   Three.js + Tauri 3D table (TypeScript)
bridge/   Java WebSocket bridge: runs Forge headless and speaks JSON to the client
engine/   Forge (cloned by scripts/build-engine.sh, not committed), plus engine/patches/: our fixes to
          Forge itself, applied by the build
scripts/  build + smoke-test helpers
docs/     protocol and Arena reference notes
```

## Running

```sh
scripts/build-engine.sh                      # once: clone + build Forge, build the bridge jar
java -jar bridge/target/forge-bridge-0.1.0.jar   # starts ws://127.0.0.1:7777
node scripts/smoke-test.mjs commander 4      # optional: plays a whole game headless
```

Card images come from Scryfall. Rules, cards and AI come from [Forge](https://github.com/Card-Forge/forge) (GPL-3.0).

# Arena reference notes (for a clean-room rebuild)

Source: the locally installed MTG Arena client (Unity **6000.3.14f1**, IL2CPP, build 2026.64.50).
Method: IL2CPP `global-metadata.dat` type/field names, and serialized MonoBehaviour config read from the
downloaded asset bundles with UnityPy (numbers and curves only; no meshes, textures, audio or code copied).
REA was used to confirm the toolchain: no native decompiler provider was available on this machine, and the
rules engine (GRE) is server-side — the client only contains `GreClient.Network.GREConnection` etc.

Everything below is **parameters we tune our own implementation against**. Values marked *(inferred)* are
interpretations, not observations.

## Coordinate frame

Unity world units, table plane is y = 0, local player toward **+z** (bottom of the screen).

## Camera — observed

| | |
|---|---|
| Projection | perspective, **FOV 34°** (vertical), near 0.3, far 1000 |
| Position | (0, **47.5**, **18**) |
| Orientation | pitched **70° below horizontal**, looking toward −z; hits the table at (0, 0, 0.71) |

One camera per battlefield scene (`Camera - Battlefield - 3D - 25 - PlayfieldForeground`), same values across scenes checked.

## Battlefield regions — observed (`BattlefieldCardHolder`)

Bounds are table-plane rectangles `x, y(=z), width, height`. Each region has several *layout variants*;
the client picks the largest card scale that fits (*inferred* from variant ordering).

| Region | Bounds (x, z, w, h) | Card scales tried (rows) | Gutter |
|---|---|---|---|
| Local creatures | −23.5, 0, 47, 5 | 1.2 → 1.1 → 1.0 → 0.9 → 0.8 → 0.7 (1 row) | 0.5 |
| Local lands | 2.5, 5.5, 21, 4.5 | 0.9 → 0.85 → 0.7 → 0.6 → 0.5 (1 row), then 0.5 ×2 rows | 0.75→0.3 |
| Local artifacts/enchantments | −23.5, 5.5, 21, 4.5 | same as lands | same |
| Local planeswalkers | −23.5, 0, 10.5, 10 | 1.0, 0.8, 0.75 (up to 2×2) | 0.5→0.3 |
| Opp creatures | −23.5, −7.5, 47, 5 | as local | 0.5 |
| Opp lands | 2.5, −12, 21, 4.5 | as local | |
| Opp artifacts | −23.5, −12, 21, 4.5 | as local | |

Identical permanents stack: stack width 1.25, up to 4 visible, count badge after 3.
`DeclaredAttackOffset` = (0, 0, 0.3) — an attacking creature slides 0.3 toward the opponent.
`TapRotation` (0, 0, −8) is an extra tilt applied with tapping *(inferred; the 90° turn itself is code)*.

## Other holders — observed

| Holder | Card size | Notes |
|---|---|---|
| Local graveyard | 0.70 | offset (1, 2.5, −2), tilted −10° X; pull-out on hover +2 y |
| Local library | 0.70 | card thickness 0.019 per card (pile height grows with library) |
| Opp graveyard | 0.50 | rotated (−10, 15, 10) |
| Opp library | 0.55 | thickness 0.014 |

## Hand fan — observed (`HandCardHolder`, desktop 16:9)

Cards sit on an arc and are placed by angle:

| Param | Expanded (hovering hand) | Collapsed |
|---|---|---|
| Radius | 45 | 18 (handheld) |
| FitAngle (total arc) | 30° | 30° |
| MaxDeltaAngle (per card) | 4.5° | 4.5° |
| YOffset | −1.5 | −2.3 |
| SpacingModifier | 0 | −0.5 |
| OverlapRotation curve (cards → degrees) | −7° up to 10 cards, easing to −22° at 55 cards | |

Hover focus spreads neighbours: `MaxFocusDistance` 7.5, focus weight curve 4 → 30 between 13 and 21 cards,
focus behaviour starts at 13 cards on desktop. Drag-to-play drop zone offset y −1.5, z +2.

Browser/zoom hover (`BrowserHoverData`): forward 2.5, y +0.35, scale 1.0 (order browser: forward 4, scale 0.65).

## Card movement — observed (`SplineMovementData`)

Every zone transition has its own spline (3 nodes with position + rotation), a **Speed**, and an easing
`AnimationCurve`. *(Inferred: duration ≈ 1 / Speed seconds.)*

| Transition | Speed | ≈ Duration | Easing character |
|---|---|---|---|
| Hand → Stack (cast) | 2.0 | 0.50 s | fast start, settles by 90% |
| Opp hand → Stack | 1.6 | 0.63 s | |
| Stack → Battlefield | 1.75 | 0.57 s | slight overshoot at 92% |
| Stack → Battlefield (flying) | 1.75 | 0.57 s | rises to 87% by 62% then glides |
| Stack → Battlefield (planeswalker) | 0.8 | 1.25 s | hold at 90% |
| Hand → Battlefield (land) | 3.0 | 0.33 s | ease-in, fast drop |
| Library → Hand (draw) | 0.7 | 1.43 s | rises to 80% by 58%, **holds** (card reveal), then finishes |
| Opp library → Opp hand | 1.2 | 0.83 s | |
| Battlefield → Graveyard | 30 | ~instant | death VFX carries the moment |
| Stack → Graveyard (resolved spell) | 2.0 | 0.50 s | |
| Most others (exile, GY↔hand…) | 1.25 | 0.80 s | ease to 1.0 at 86% |

Spline example — Stack → Battlefield starts high (y 26.5) and off to the side, swoops through (−3.9, 20, 3.6),
lands at its slot flat (rot x 90).

## Combat — observed (`Combat.Spline*`)

Attack "collision" animation is tiered by **power**:

| Power | Strike speed | Return speed |
|---|---|---|
| 1 | 3.0 | 1.5 |
| 2–3 | 2.5 | 1.25 |
| 4–7 | 2.0 | 0.6 |
| 8+ | 1.5 | 0.5 |

Bigger creatures wind up slower and recover slower. Separate `_Self` variants are a wobble of the struck card
(rotation 355°/240° about z); `_Battle` variants target battle permanents; `Opp` variants mirror direction.

## Targeting

`IntentionLinePrefab` uses a Dreamteck spline renderer with an animated arrow head
(`DreamteckIntentionArrowBehavior`, `ScaleArrowheadBehavior`) — i.e. a curved, animated arrow from source to target.

## VFX taxonomy (names only)

Bundle families give the event → effect map Arena uses; we author our own effects for each:
`Card.EtbVFX`, `Card.EtbTriggerVFX`, `Card.DeathVFX`, `Card.DeathPayload_VFX_Victim`, `Card.MovementPayload_Stack_VFX`,
`Card.MovementPayload_NonStack_VFX`, `Card.ChoiceVFX`, `Card.Highlight`, `Avatar.DeathVFX`, `Avatar.HighlightVFX`,
`Ability.GainVfx`, `Projectile.SplinePayload`, `Resource.SplinePayload` (mana), `RegionTransfer.RegionVFX`,
`Card.DepthArtAnimSettings` (parallax "depth art").

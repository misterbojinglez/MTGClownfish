# Arena's rules interactions, compared with ours

Review of 2026-11-23, for deciding what (if anything) to take from Arena's interaction design. Companion to
`arena-reference.md` (camera, layout, motion). No code was changed as part of this review.

## Evidence

Arena client 2026.64.50: type, field, method and enum names from IL2CPP metadata, and English interface text from
the client's localization database. No method bodies were read, no match was played, and no code, art or prompt
text should be copied from it. Grades used below:

- **S** seen: interface text or an enum states it.
- **N** named: class, method or field names say it; details are our reading.
- **G** general knowledge of how Arena plays; not checked here.

Our side was read from the source (client, bridge, Forge's human controller), except where a row says untested.
"Not found" means not in what was searched, which isn't proof Arena lacks it.

## Arena's model

- About 60 "workflows", one per kind of rules decision. Each owns its highlights, dimming, arrows, buttons and
  prompt (N). Decisions stay on the table when the objects are on the table; cards from hidden zones, or choices
  with no object, open one of 31 kinds of "browser" (S).
- Many workflows try to answer themselves first (`TryAutoRespond`, `CanAutoSubmit`), with the player's settings
  deciding how far that goes (N). Arena also removes decisions with no consequence; we mostly render what Forge asks.
- Highlights are graded Hot / Tepid / Cold (S). Cold marks a legal choice that is probably a mistake, and picking
  one can ask for confirmation (S: several "cold highlight" warnings).
- Buttons say the result ("2 Attackers", "No Blocks", "X = 3"), not OK (S).

## Comparison

Verdicts: **Same**; **Ours** (keep ours); **Adopt**; **Consider**; **Skip**.

### Priority and passing
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Nothing to do | Auto-passes (S) | Auto-passes, with extra checks for things Forge misses | Same |
| Phase stops | Per step and per player, click the phase ladder; also a one-time "next" stop (S) | Fixed: your mains and blocks; opponent's attacks, blocks and end step. The phase bar is display only | **Adopt** |
| Full control | Temporary, or locked; stops everywhere (S) | None. Upkeep, draw and beginning of combat can't be stopped at with an empty stack | **Adopt** |
| Your own spell on the stack | Passes for you unless in full control (option `ResolveMyStackEffects` S; default G) | You press Pass Priority whenever you have anything usable | Consider, as a setting |
| Pass turn | A toggle: Pass Turn / Pass Until Response / Resume Turn (S) | One way. Interrupted by opponents' spells and attacks; no button to take it back | **Adopt** the resume |
| Resolve all | Resolve All, becoming Respond (S) | OK to all, becoming Stop; also stops when an opponent adds something | Same |
| Next-step label | Button says where passing goes: To Combat, To End (S) | Always "Pass Priority" | **Adopt** |
| Per-ability yield | In the protocol: by ability or card (S); the UI for it not found | None, though Forge supports it | Consider |

### Casting and paying
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Play from hand | Click, or drag past a screen-height threshold (N) | Click, or drag past 12% of the screen | Same |
| Auto-pay | Automatic, or buttons for each distinct plan, e.g. Pay With Treasure (S) | Automatic, previewed in violet; never sacrifices a source unasked | Same; alternative plans **Consider** |
| Several ways to cast | Card picker, each card headed with its cost or form (S) | List labelled by how you'd pay | Same idea |
| Modes | Full-size cards, one per mode, picked together; counts remaining (S) | One dialog per mode, each a copy of the same card with text below | **Adopt** |
| X | Stepper (±1, ±5) at the card; button reads "X = n"; asks before 0 (N, S) | List of 0–9 and "Other", one click commits | **Adopt** |
| Colour for mana | Wheel at the source; can tap a stack as a batch (N) | Dialog listing colours | Consider |
| Phyrexian mana | Picker (S) | Pay life button, plus asking when life is the only way left | Ours |
| Undo | Undo button and Z (S); steps back through targets (N) | Undo button; Z presses Cancel instead | **Adopt** the key |
| Can't play it | Says which card may not be played and why (S, N) | Says which cost can't be paid; otherwise silent for many cases | Consider |

### Targets and choices
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| On the table | Click, arrow follows the pointer, others dim (N) | Click, highlights, no dimming or pointer arrow for targets | Consider |
| Prompt | Count, and "(n of count)" for several target groups (S) | Forge's text plus picked/max | Consider |
| Risky pick | Cold highlight, and confirm: yourself, an opponent for a benefit, ward (S) | None: every legal target looks alike | **Adopt**, starting with yourself and ward |
| Off-table | Browser; zone tabs when choices span zones (S) | Browser; a single row across zones | Same; zone grouping Consider |
| Up to N, none chosen | Declining has its own button (S) | "Choose nothing", and Space won't press it | Same |
| Look at the board mid-choice | View Battlefield / View Browser (S) | Dialogs cover the board; only The Stack tucks away | **Adopt** |
| Divide damage or counters | Steppers on the targets themselves (N) | Dialog with rows | Consider |
| Select all | Button (S) | None | Consider |

### Library
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Scry | Drag, Bottom at left and Top at right (S) | Two labelled areas, click to move, arrows to order | Ours; drag as an extra |
| Surveil | Drag, graveyard and library groups (S) | Same dialog as scry | Same |
| Other "look and place" effects | Reuse the scry or surveil browser (S, N: "scryish") | Forge's own one- or two-step prompts | **Adopt** our own dialog for them |
| Order cards | Drag, First/Last or Top/Bottom captions at the ends (S) | Click in order | Same; end captions Consider |
| Skip repeated scries | Not found | Confirm & skip | Ours |
| Opponent's scry result | "1 top, 1 bottom" (S) | Not shown, though the event already arrives | **Adopt** |
| Piles | Drag to split, Select per pile (S) | Select per pile; splitting is a plain pick | Same; splitting Consider |

### Triggers and replacements
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Order triggers | Drag, First to Last; setting to do it for you (S) | Click in order; "Keep as shown"; asked again for repeats (Forge can remember, the bridge always answers no) | **Adopt** remember |
| Replacement order | Cards; setting to do it for you (S) | Click in order; same missing remember | **Adopt** remember |
| May abilities | Buttons named for the act: Reveal, Sacrifice, Transform (S) | Mostly Yes / No | Consider |
| Single target for a trigger | Can auto-target (N) | Asks | Consider |

### Combat
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Declare | Click or drag (N) | Click, drag, or box-select a group | Ours |
| Attack buttons | No Attacks / All Attack / n Attackers / Cancel Attacks (S) | OK / Alpha Strike / Call Back | **Adopt** |
| Block buttons | No Blocks / n Blockers / Cancel Blocks (S) | OK only; no way to clear all blocks at once | **Adopt** |
| Illegal declaration | Warnings on the creatures: must attack, can't block alone, needs more blockers (S) | Named in a message after the fact; blocks checked on confirm | Consider |
| Attack costs | Running "Cost: n" while declaring (S) | Paid after declaring (our prompt flow untested) | Consider |
| Assign damage | Steppers, drag to reorder, Auto Allocate toggle (S, N) | Steppers starting from the lethal split, marks deaths | Ours; setting to skip Consider |
| Skipped blocks, haste | Not found | Explained in a message | Ours |

### Opening hand and information
| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Mulligan | Large hand; Keep n / Mulligan; says how many go back (S) | Hand in its fan; Keep / Mulligan; Forge's text | Consider the count |
| London bottom | Drag between hand and library (S) | Click cards in hand, which rise | Same |
| Play warnings | Setting; duplicate legendary and others, limited per turn (S, N) | Only for abilities with nothing to choose | **Adopt** duplicate legendary |
| Hand too big | Warned before end of turn (S) | Not shown | Consider |
| Related faces, tokens, chosen names | Panels beside the zoom (S) | Card zoom with power and toughness breakdown | Consider |
| Predicted damage, storm counts | In rules text (S) | Not shown | Consider |
| Timers and rope | Yes (S) | None; games with friends and AI | Skip |
| Multiplayer view, votes, radial menu, commander damage | Two-player design (G) | Built for four | Ours |

## Library and damage families (second pass, 2026-11-23)

Same evidence grades, plus Arena's asset lookup tables (JSON naming which abilities and prompts use which screen),
graded **S**. Our side here was **run**: each card named in "Run" was cast against our bridge and its questions
recorded (one answer path each). Combat rows are from source.

### How Arena groups the library family

Not one screen. The shape of the decision picks the screen:

| Decision | Arena's screen | Cards that show it |
|---|---|---|
| Split N cards between two ends | Scry or surveil group browser, drag (S) | Scry, surveil, London mulligan: the only three grouping kinds in the protocol |
| One card, two destinations | Borrowed scry-style or surveil-style browser, drag (S) | "May put it into your graveyard / on the bottom" (Cabaretti Ascendancy, Ajani Sleeper Agent, Sarinth Steelseeker), "top or bottom" |
| Exactly one of N to the graveyard | Surveil-style, Done held until it's legal (S, N) | Oglor, Soulcipher Board, Celestus Sanctifier |
| Second from top or bottom | Scry-style with placeholder cards for what's above (S, N) | "Scryish" |
| Pick K of N, the rest elsewhere | Card browser, all N shown, only legal ones selectable (N) | Manifest dread, look-at-top-N effects |
| Order the rest, or order the top | Order browser, drag, Top/Bottom captions at the ends (S) | Ordering context is sent as top or bottom |
| Search | Card browser; whole selection at once; "End Search"; zone tabs (S) | Tutors |
| Piles | Drag to split; Select per pile (S) | Two-pile effects |
| Explore | Its own optional-action screen (N; layout unknown) | Explore |

The borrowed screens are a hand-kept list of abilities and prompts, so they cover a few cards rather than the family.

### Ours, as run

| Decision | Run | What we ask | Difference |
|---|---|---|---|
| Pick, then rest on the bottom | Impulse, Anticipate, Dig Through Time | Pick dialog, then order dialog | Same two steps. **Bug:** the order caption says "Closest to top" for a bottom, and the first card picked went to the very bottom (checked by drawing the library) |
| Put on top, order | Ponder, Brainstorm | Order dialog | Same; no end captions on the row |
| Pick some, rest to graveyard | Grisly Salvage | A reveal to dismiss, then a pick showing only legal cards | Arena shows all N in one screen. Ours says nothing about where the rest goes |
| Hand, top and bottom | Telling Time | Two picks, the third implied; reads "on top of You library" | Wants one screen with three places |
| Explore | Merfolk Branchwalker | A reveal to dismiss, then Yes / No in the prompt corner | Wants our two-place dialog, one card |
| Manifest dread | Manifest Dread | One pick dialog | Same; ours doesn't say the other card goes to the graveyard |
| Search several, all different | Gifts Ungiven | Four dialogs in a row | One dialog |
| Search several | Cultivate | One dialog | Same |
| Opponent's hand | Duress | A reveal to dismiss, then a pick | One screen, illegal cards dimmed |
| Delve | Dig Through Time | A number list, then one dialog per card (source) | One graveyard pick, with the cost falling as you pick |
| Piles, chooser | Fact or Fiction | A reveal, then piles | Same |
| Scry to the bottom, several | our new dialog | No order shown for the bottom | **Gap in our dialog:** click order is used but not shown. Scry lets you order the bottom |

Forge's data has roughly 750 cards with scry or surveil, 970 using its "look at the top and place" effect, 180
"dig until", 1,190 moving cards out of the library, 48 explore and 39 manifest dread. These are file matches that
overlap, so they're a guide to scale only.

### Damage and dividing

| Interaction | Arena | Ours | Verdict |
|---|---|---|---|
| Where | One screen: attacker, its blockers, and the player or planeswalker attacked, as cards; a stepper on each (N) | Rows of names with steppers, card on hover | **Adopt** cards |
| Start | Auto Allocate toggle; drag blockers to set priority (S, N) | Lethal split in Forge's order; no reordering | Keep ours; **Adopt** a "lethal in this order" reset |
| Adding a point with none left | Moves one from another (N: `Increment_Transfer`) | Same, from the last row that can spare one | Same |
| Colours | Unassigned, damaged, lethal (N) | Red when lethal | Same |
| Replacements | Flags damage a replacement changes (N) and has a switch for the colours | Not considered: "kills it" ignores prevention, protection and doubling | **Adopt**: don't claim "kills it" when unsure |
| Assign as though unblocked | Asked first, as its own question (S) | One dialog, free split for "divided as you choose"; Forge asks first for other cases | Same |
| Several attackers | Queue, with undo (N) | One at a time, no going back; Forge's "assign another first" is ignored | Consider |
| Trample | Held until blockers have lethal (N) | Same, with a reason shown. **Bugs** below | Same |
| Skip entirely | Auto-assign setting (S) | None | **Adopt** as a setting (off) |
| Divide spell damage or counters | Steppers on the targets, on the table (N) | A dialog after targeting (run: Fury, Biogenic Upgrade) | Consider: ours hides the board you're aiming at |
| Damage already fixed | Not asked (N: auto-respond) | Not asked (source) | Same |
| Remove or move counters | Steppers on permanents (N) | List picks (source) | Consider |
| Exert / enlist | Choice at the attacker as you declare (S) | An order dialog: "Confirm order" for a yes/no per creature (source) | **Adopt** a plain pick |

### Bugs found while comparing

1. **Wrong end of the library.** Rest-on-the-bottom ordering says "Closest to top" (Forge's label, shown by us). Run
   with Impulse: the first card chosen was the last one drawn.
2. **Trample over planeswalkers.** Forge adds the planeswalker to the blockers; our `lethal()` uses creature toughness
   with a minimum of 1, where Forge's desktop screen uses loyalty. From source, not run.
3. **Blockers that already have lethal.** Our minimum of 1 makes a trampler assign a point it needn't (an
   indestructible blocker with lethal damage marked, or lethal already assigned by another attacker). Forge's
   desktop screen allows 0. From source, not run.
4. **Scry bottom order** isn't visible in our new dialog (above).

### What to build from this

A single **place-the-cards dialog**: two or three named places, per-place limits, order shown wherever order matters,
and Confirm held until it's legal. Scry and surveil become two uses of it. It would also cover pick-and-rest, top
and bottom ordering, explore, Telling Time, manifest dread and London mulligan. Forge asks pick and order
separately, so merging them means overriding the ask per effect, with Forge's own prompts as the fallback.
This goes further than Arena, whose borrowed screens cover a short list.

## Built (2026-11-23)

Everything under "Recommended order", plus the damage screen, on-target steppers, the four bugs, and the automation
as settings (off by default). The comparison tables above describe the game **before** this work.

- Bridge requests: `place` (scry, surveil, explore, look-and-place, library order, manifest dread), `modes`, `number`;
  `choose` gained `disabled` and `distinct`, `order` gained `canRemember`. Overrides are in `BridgeHumanPlayer.Controller`.
  Effects they don't recognise fall back to Forge's own prompts.
- Player options travel as `{type:'options'}` (`stops.ts`, `settings.ts` → `Client.options`).
- A reveal that the next dialog shows anyway is held back, and shown at the next priority if no dialog came.
- Not done from the "Consider" rows. Two-pile splitting, colour wheel, per-ability yields and the rest are as before.

## Choosing across several graveyards (2026-11-24)

Arena: cards off the table open a browser; when they come from several zones it has a button per zone and shows one
zone at a time, starting from a computed one (S: "Click a zone name on the left to view that zone"; N:
`SelectCardsBrowser_MultiZone`, `_cardViewsByZoneId`, `StartingZoneIdCalculator`). Several target groups are stepped
through with "(n of count)" (S). Afterlife from the Loam isn't in Arena's card data; the nearest there are Breach the
Multiverse (one per player), Boneyard Parley, Liliana the Necromancer, Ancient Brass Dragon and Fire Lord Sozin (any
graveyards), and Jetsam (each opponent's). The method bodies weren't read, so how Arena words each is unknown.

Ours: every graveyard at once, a section per player in turn order, since four zones behind buttons hide what's being
compared. "One per player" swaps within a section (`Prompt.onePer`, from Forge's ForEachPlayer / different
controllers); "all from one player" dims the rest. Breach the Multiverse asked three times about "this player's
graveyard"; it's now one dialog (`BridgeHumanPlayer.onePerPlayer`). Any pick over several zones gets the sections.

## Recommended order

Effort is a rough guess: S under an hour or two, M about half a day, L more.

1. **Say what the button does** (S): No Attacks / 2 Attackers / No Blocks / 2 Blockers, To Combat, Z to undo.
   Client only. "To Combat" needs care because auto-pass can carry further than the next step.
2. **View Battlefield** on every dialog (S). Client only.
3. **X stepper and one-dialog modes** (M). Both need a bridge override, like scry's.
4. **Stops and full control** (M–L): clickable phase bar, per player, one-time stops; hold-to-control. Forge already
   has `setSkipPhase` and full-control flags; ours is hard-coded in `SocketGuiGame.isUiSetToSkipPhase`. Includes
   Resume Turn.
5. **Warnings** (M): targeting yourself, ward, duplicate legendary. Needs a setting to turn them off. Wrong warnings
   are worse than none, so start with these three.
6. **Remember my order** for triggers and replacements (S–M): pass Forge's flag through, with a way to forget.
7. **One "look and place" dialog** beyond scry and surveil, and opponents' scry results (M).

## Where Arena's way would be wrong here

- **Automating decisions by default.** Arena's default hides legal plays (upkeep, your own stack) to speed up
  two-player games. At a four-player table, keep holding by default and offer the automation as settings.
- **Drag only.** Arena's library and ordering text says drag. Click-first is quicker with a mouse and works from the
  keyboard; drag can be added beside it.
- **Its look and wording.** Take the structure of an interaction, in our own words and visual language.

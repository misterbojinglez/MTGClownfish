package tabletop.bridge;

import forge.game.Game;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetRestrictions;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;

import java.util.ArrayList;
import java.util.List;

/**
 * The human seat, with one addition to Forge's controller: when a triggered ability of yours can't go on
 * the stack because it has no legal target (Phyrexian Delver entering with no creature card in your
 * graveyard), Forge drops it silently. Rule 603.3d, but easy to miss, so the player is told.
 */
final class BridgeHumanPlayer extends LobbyPlayerHuman {

    /*
     * Asking Forge what can be played (getAllPossibleAbilities) re-runs static abilities and freezes the game's
     * change tracker, so it must only happen on the game thread: done off it (while sending updates), it
     * collided with the AI's own evaluation and killed the game thread (the game hung "Waiting for…").
     * These are worked out each time you get priority, on the game thread, and read when updates are sent.
     */
    /* each per human seat (by player id), since several people can share a game online */
    /** battlefield cards with an X-targeted ability ready to use (Chthonian Nightmare) */
    private static final java.util.Map<Integer, java.util.Set<Integer>> READY_X = new java.util.concurrent.ConcurrentHashMap<>();
    /** the top card of the player's library, when they could play it right now (Bolas's Citadel) */
    private static final java.util.Map<Integer, Integer> PLAYABLE_TOP = new java.util.concurrent.ConcurrentHashMap<>();
    /** prepared permanents whose waiting spell copy the player could cast right now (Emeritus of Woe) */
    private static final java.util.Map<Integer, java.util.Set<Integer>> PREPARED_READY = new java.util.concurrent.ConcurrentHashMap<>();
    /** cards in exile the player could play right now (Forge's scan doesn't look in exile) */
    private static final java.util.Map<Integer, java.util.Set<Integer>> EXILE_READY = new java.util.concurrent.ConcurrentHashMap<>();
    /** cards the player could use right now that Forge's own scan turned down for mana it can't plan (life payments) */
    private static final java.util.Map<Integer, java.util.Set<Integer>> USABLE_READY = new java.util.concurrent.ConcurrentHashMap<>();

    /** battlefield cards Forge's scan misses that this player could use now: X-targeted abilities, prepared spells */
    static java.util.Set<Integer> readyCards(final int playerId) {
        final java.util.Set<Integer> all = new java.util.HashSet<>(READY_X.getOrDefault(playerId, java.util.Set.of()));
        all.addAll(PREPARED_READY.getOrDefault(playerId, java.util.Set.of()));
        all.addAll(EXILE_READY.getOrDefault(playerId, java.util.Set.of()));
        all.addAll(USABLE_READY.getOrDefault(playerId, java.util.Set.of()));
        all.remove(-1);
        return all;
    }

    /** The top of this player's library when they could play it right now, else -1. */
    static int playableTop(final int playerId) {
        return PLAYABLE_TOP.getOrDefault(playerId, -1);
    }

    /** A new game: nothing carried over from the last one (player ids are reused). */
    static void resetAll() {
        READY_X.clear();
        PLAYABLE_TOP.clear();
        PREPARED_READY.clear();
        EXILE_READY.clear();
        USABLE_READY.clear();
    }

    BridgeHumanPlayer(final String name) {
        super(name);
    }

    @Override
    public Player createIngamePlayer(final Game game, final int id) {
        final Player player = new Player(forge.util.GuiDisplayUtil.personalizeHuman(getName()), game, id);
        player.setFirstController(new Controller(game, player, this));
        return player;
    }

    private static final class Controller extends PlayerControllerHuman {
        Controller(final Game game, final Player player, final LobbyPlayerHuman lobby) {
            super(game, player, lobby);
        }

        /**
         * Forge's "pass when there's nothing to do" ignores mana abilities, so a main phase whose only option
         * is a sacrifice outlet that makes mana (Soldevi Adnate, Ashnod's Altar) was passed straight through.
         * Sacrificing something is a real decision, so in your own main phase with an empty stack, when such an
         * ability is usable, auto-pass is held for this priority.
         */
        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            // game thread: safe to evaluate abilities here; updates sent while you hold priority read these
            final int me = getPlayer().getId();
            final java.util.Set<Integer> readyX = java.util.Set.copyOf(readyXNow());
            final int playableTop = libraryTopPlayable();
            final java.util.Set<Integer> preparedReady = java.util.Set.copyOf(preparedNow());
            READY_X.put(me, readyX);
            PLAYABLE_TOP.put(me, playableTop);
            PREPARED_READY.put(me, preparedReady);
            final java.util.Set<Integer> exileReady = java.util.Set.copyOf(exileNow());
            EXILE_READY.put(me, exileReady);
            // a boast worth offering the moment it becomes usable (Baron Helmut Zemo after attacking): asked
            // once a turn, and a yes plays it as if the card had been clicked
            final SpellAbility boast = boastOffer();
            if (boast != null) {
                return new java.util.ArrayList<>(java.util.List.of(boast));
            }
            // and the live facts every snapshot carries (cards playable from exile, mana available): the
            // snapshots sent while you decide are mostly built off the game thread, where they can't be worked out
            Serializer.refreshLive(getGame());
            final forge.game.phase.PhaseHandler ph = getGame().getPhaseHandler();
            final boolean myMain = ph.isPlayerTurn(getPlayer()) && ph.getPhase() != null && ph.getPhase().isMain() && getGame().getStack().isEmpty();
            // a chance to respond: something is on the stack (an opponent's spell, ability or trigger), or this is
            // one of the steps the table stops at (declare attackers, end of turn...); elsewhere the step is
            // skipped whatever the player holds
            final boolean responding = !getGame().getStack().isEmpty();
            final boolean atStop = ph.getPlayerTurn() != null && ph.getPhase() != null
                    && !getGui().isUiSetToSkipPhase(ph.getPlayerTurn().getView(), ph.getPhase());
            final boolean chance = responding || atStop;
            // Forge passes for you when its own scan finds nothing you could do, and that scan prices costs with
            // the AI's mana planner, which turns down costs you can pay (Phyrexian mana and K'rrik's {B} with
            // life): look again, more generously, before letting it pass. A yield you asked for still wins.
            final java.util.Set<Integer> usable = chance && !getYieldController().isYieldActive() ? usableNow() : java.util.Set.of();
            USABLE_READY.put(me, usable);
            // cards castable from exile hold only a real chance to use them (an instant sitting in exile would
            // otherwise stop auto-pass at every step)
            final boolean hold = sacrificeOutletReady() || playableTop >= 0 || !preparedReady.isEmpty() || (!readyX.isEmpty() && getGame().getStack().isEmpty())
                    || ((myMain || chance) && !exileReady.isEmpty()) || !usable.isEmpty();
            final forge.gamemodes.match.YieldController yc = getYieldController();
            if (hold) {
                yc.setPref(forge.localinstance.properties.ForgePreferences.FPref.YIELD_AUTO_PASS_NO_ACTIONS, "false");
            }
            try {
                return super.chooseSpellAbilityToPlay();
            } finally {
                if (hold) {
                    yc.setPref(forge.localinstance.properties.ForgePreferences.FPref.YIELD_AUTO_PASS_NO_ACTIONS, "true");
                }
            }
        }

        /**
         * Boasts the table offers by asking, rather than leaving them to a click on the card: Baron Helmut Zemo's
         * (fifteen black mana symbols' worth of graveyard is easy to lose track of, and the moment passes with
         * the turn).
         */
        private static final java.util.Set<String> OFFERED_BOASTS = java.util.Set.of("Baron Helmut Zemo");
        private int boastAskedTurn = -1;
        private final java.util.Set<Integer> boastAsked = new java.util.HashSet<>();

        /**
         * A creature of yours named in {@link #OFFERED_BOASTS} attacked this turn and its boast can be activated
         * and paid for right now (with a cost like Zemo's, that checks the graveyard): asks once per creature
         * per turn whether to use it, and returns it on a yes. A yield you set wins: nothing is asked.
         */
        private SpellAbility boastOffer() {
            try {
                final Game game = getGame();
                final Player me = getPlayer();
                if (getYieldController().isYieldActive()) {
                    return null;
                }
                final int turn = game.getPhaseHandler().getTurn();
                if (turn != boastAskedTurn) {
                    boastAskedTurn = turn;
                    boastAsked.clear();
                }
                for (final forge.game.card.Card c : me.getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                    if (!OFFERED_BOASTS.contains(c.getName()) || boastAsked.contains(c.getId())
                            || c.getDamageHistory().getCreatureAttacksThisTurn() == 0) {
                        continue;
                    }
                    for (final SpellAbility sa : c.getSpellAbilities()) {
                        if (!sa.isBoast()) {
                            continue;
                        }
                        sa.setActivatingPlayer(me);
                        if (!sa.canPlay() || !forge.game.cost.CostPayment.canPayAdditionalCosts(sa.getPayCosts(), sa, false)) {
                            continue;
                        }
                        boastAsked.add(c.getId());
                        final String text = sa.getDescription().replaceFirst("^Boast\\s*[—-]\\s*", "").replaceAll("\\s*\\(Activate only[^)]*\\)", "");
                        if (getGui().showConfirmDialog(c.getName() + " attacked: use its Boast?\n\n" + text, "Boast", "Boast", "Not now", true)) {
                            return sa;
                        }
                    }
                }
            } catch (final RuntimeException ignored) {
                // mid-update: nothing offered this time
            }
            return null;
        }

        /** Sentinel in {@link #usableNow}'s answer: the scan ran out of time, so assume there is something. */
        private static final int UNFINISHED = -1;

        /**
         * Cards of yours (hand, battlefield, graveyard, command zone, exile) with something you could use now, by
         * {@link Serializer#usableNow}. Run as the AI, like Forge's own scan, so working out a cost never stops to
         * ask you anything.
         */
        private java.util.Set<Integer> usableNow() {
            final Player me = getPlayer();
            final Serializer.UsableScan[] scan = new Serializer.UsableScan[1];
            try {
                me.runWithController(() -> scan[0] = Serializer.usableNow(me, 800),
                        new forge.ai.PlayerControllerAi(getGame(), me, me.getOriginalLobbyPlayer()));
            } catch (final RuntimeException e) {
                return java.util.Set.of();
            }
            if (scan[0] == null) {
                return java.util.Set.of();
            }
            final java.util.Set<Integer> ids = new java.util.HashSet<>(scan[0].cards());
            if (scan[0].incomplete()) {
                ids.add(UNFINISHED);
            }
            return java.util.Set.copyOf(ids);
        }

        private java.util.List<Integer> exileNow() {
            try {
                return Serializer.exileReady(getPlayer());
            } catch (final RuntimeException e) {
                return java.util.List.of();
            }
        }

        /** Prepared permanents whose spell copy (in exile, cast by permission) you could cast right now. */
        private java.util.List<Integer> preparedNow() {
            final java.util.List<Integer> ids = new java.util.ArrayList<>();
            try {
                for (final forge.game.card.Card c : getPlayer().getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                    final forge.game.card.Card spell = c.isPrepared() ? c.getPreparedSpell() : null;
                    if (spell != null && Serializer.playableNow(spell, getPlayer())) {
                        ids.add(c.getId());
                    }
                }
            } catch (final RuntimeException ignored) {
                // can't tell; Forge's own scan stands
            }
            return ids;
        }

        /** Abilities whose target depends on X (Chthonian Nightmare) with a legal target for some X you could pay. */
        private java.util.List<Integer> readyXNow() {
            try {
                return Serializer.readyXAbilities(getPlayer());
            } catch (final RuntimeException ignored) {
                return java.util.List.of();
            }
        }

        /**
         * The top of your library is a card you may play right now (Bolas's Citadel, Future Sight): Forge's
         * pass-when-nothing-to-do never looks in the library, so it would pass right by it.
         */
        private int libraryTopPlayable() {
            try {
                final Player me = getPlayer();
                final forge.game.zone.PlayerZone lib = me.getZone(forge.game.zone.ZoneType.Library);
                if (lib == null || lib.isEmpty()) {
                    return -1;
                }
                final forge.game.card.Card top = lib.get(0);
                return top.getView().canBeShownTo(me.getView()) && Serializer.playableNow(top, me) ? top.getId() : -1;
            } catch (final RuntimeException ignored) {
                return -1;
            }
        }

        /** Your main phase, nothing on the stack, and a mana ability you could use that sacrifices another permanent. */
        private boolean sacrificeOutletReady() {
            try {
                final Game game = getGame();
                final Player me = getPlayer();
                if (!game.getPhaseHandler().isPlayerTurn(me) || !game.getPhaseHandler().getPhase().isMain() || !game.getStack().isEmpty()) {
                    return false;
                }
                for (final forge.game.card.Card c : me.getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                    for (final SpellAbility ma : c.getManaAbilities()) {
                        if (ma.getPayCosts() == null) {
                            continue;
                        }
                        boolean sacrificesOther = false;
                        for (final forge.game.cost.CostPart part : ma.getPayCosts().getCostParts()) {
                            if (part instanceof forge.game.cost.CostSacrifice && !part.payCostFromSource()) {
                                sacrificesOther = true;
                            }
                        }
                        if (!sacrificesOther) {
                            continue;
                        }
                        ma.setActivatingPlayer(me);
                        if (ma.canPlay() && forge.game.cost.CostPayment.canPayAdditionalCosts(ma.getPayCosts(), ma, false)) {
                            return true;
                        }
                    }
                }
            } catch (final RuntimeException ignored) {
                // mid-update; fall back to Forge's own judgement
            }
            return false;
        }

        /**
         * Forge starts an ability without checking that every cost can be paid, and pays costs one at a time;
         * when a later one turns out impossible, its rollback doesn't undo them all. Chthonian Nightmare with no
         * creature to sacrifice went back to your hand and did nothing. So a cost that can't be paid (other than
         * mana, which the payment prompt handles, and amounts that depend on X, not chosen yet) stops the
         * ability before it starts, and the player is told which cost.
         */
        @Override
        public boolean playChosenSpellAbility(final SpellAbility chosenSa) {
            final String blocked = unpayableCost(chosenSa);
            if (blocked != null) {
                final String name = chosenSa.getHostCard() == null ? "That" : chosenSa.getHostCard().getName();
                if (getGui() instanceof SocketGuiGame gui) {
                    gui.tell(name + ": can't pay \"" + blocked + "\" right now.");
                }
                return false;
            }
            final String nothing = nothingToChoose(chosenSa);
            if (nothing != null && getGui() instanceof SocketGuiGame gui) {
                final forge.game.card.Card host = chosenSa.getHostCard();
                final String name = host == null ? "That" : host.getName();
                final boolean go = gui.confirm(host == null ? null : host.getView(),
                        name + ": there's no " + nothing + " to choose yet, so it would do nothing right now.",
                        false, List.of("Activate anyway", "Cancel"));
                if (!go) {
                    return false;
                }
            }
            return super.playChosenSpellAbility(chosenSa);
        }

        /**
         * An ability that opens by choosing a card from a filter (Forcefield: "an unblocked creature of your
         * choice") does nothing when nothing fits, yet Forge takes the payment and resolves it silently.
         * Activated during declare attackers, before any creature is unblocked, Forcefield was a wasted {1}.
         * Returns what it would choose ("unblocked creature") when nothing fits right now, else null.
         */
        private String nothingToChoose(final SpellAbility sa) {
            try {
                if (sa == null || sa.getApi() != forge.game.ability.ApiType.ChooseCard || !sa.hasParam("Choices")
                        || sa.hasParam("DefinedCards") || sa.hasParam("AllCards") || sa.hasParam("IncludeSpellsOnStack")
                        || sa.hasParam("Defined") || sa.usesTargeting()) {
                    return null;
                }
                final Player me = getPlayer();
                final forge.game.card.Card host = sa.getHostCard();
                sa.setActivatingPlayer(me);
                final List<forge.game.zone.ZoneType> zones = sa.hasParam("ChoiceZone")
                        ? forge.game.zone.ZoneType.listValueOf(sa.getParam("ChoiceZone"))
                        : List.of(forge.game.zone.ZoneType.Battlefield);
                forge.game.card.CardCollectionView choices = forge.game.card.CardLists.getValidCards(
                        me.getGame().getCardsIn(zones), sa.getParam("Choices"), me, host, sa);
                if ("Chooser".equals(sa.getParam("ControlledByPlayer"))) {
                    choices = forge.game.card.CardLists.filterControlledBy(choices, me);
                } else if (sa.hasParam("ControlledByPlayer")) {
                    return null; // depends on another player; don't guess
                }
                return choices.isEmpty() ? describeChoices(sa) : null;
            } catch (final RuntimeException ignored) {
                return null; // can't tell; let Forge decide
            }
        }

        /** "Creature.unblocked" → "unblocked creature"; ChoiceDesc when the script has one. */
        private static String describeChoices(final SpellAbility sa) {
            if (sa.hasParam("ChoiceDesc")) {
                return sa.getParam("ChoiceDesc");
            }
            final String choices = sa.getParam("Choices");
            if (choices.matches("[A-Za-z]+(\\.[A-Za-z]+(\\+[A-Za-z]+)*)?")) {
                final String[] parts = choices.split("\\.", 2);
                final String type = parts[0].equals("Card") ? "card" : parts[0].toLowerCase();
                if (parts.length == 1) {
                    return type;
                }
                final List<String> props = new ArrayList<>();
                String after = "";
                for (final String p : parts[1].split("\\+")) {
                    switch (p) {
                        case "YouCtrl" -> after = " you control";
                        case "OppCtrl" -> after = " an opponent controls";
                        case "YouOwn" -> after = " you own";
                        default -> props.add(p.replaceAll("([a-z])([A-Z])", "$1 $2").toLowerCase());
                    }
                }
                return (props.isEmpty() ? "" : String.join(" ", props) + " ") + type + after;
            }
            return "eligible card";
        }

        /** Two piles shown as two piles, each chosen with its own button (see SocketGuiGame.choosePile). */
        @Override
        public boolean chooseCardsPile(final SpellAbility sa, final forge.game.card.CardCollectionView pile1,
                                       final forge.game.card.CardCollectionView pile2, final String faceDown) {
            if (!(getGui() instanceof SocketGuiGame gui)) {
                return super.chooseCardsPile(sa, pile1, pile2, faceDown);
            }
            // as Forge's: FaceDown "One" hides pile 1, "True" hides both
            final boolean show1 = "False".equals(faceDown);
            final boolean show2 = !"True".equals(faceDown);
            if (show1) tempShowCards(pile1);
            if (show2) tempShowCards(pile2);
            try {
                return gui.choosePile("Choose a pile",
                        new ArrayList<>(forge.game.card.CardView.getCollection(pile1)),
                        new ArrayList<>(forge.game.card.CardView.getCollection(pile2)), show1, show2);
            } finally {
                endTempShowCards();
            }
        }

        /** The first non-mana cost of this ability that can't be paid now, or null. */
        private String unpayableCost(final SpellAbility sa) {
            try {
                if (sa == null || sa.getPayCosts() == null) {
                    return null;
                }
                sa.setActivatingPlayer(getPlayer());
                for (final forge.game.cost.CostPart part : sa.getPayCosts().getCostParts()) {
                    if (part instanceof forge.game.cost.CostPartMana) {
                        continue;
                    }
                    final String amount = part.getAmount();
                    if (amount != null && amount.contains("X")) {
                        continue;
                    }
                    if (!part.canPay(sa, getPlayer(), false)) {
                        return part.toString();
                    }
                }
            } catch (final RuntimeException ignored) {
                // can't tell; let Forge decide
            }
            return null;
        }

        @Override
        public void orderAndPlaySimultaneousSa(final List<SpellAbility> activePlayerSAs) {
            // targets are chosen as each trigger goes on the stack; note which ones need one
            final List<SpellAbility> targeted = new ArrayList<>();
            for (final SpellAbility sa : activePlayerSAs) {
                if (sa.isTrigger() && !sa.isCopied() && sa.usesTargeting()) {
                    targeted.add(sa);
                }
            }
            super.orderAndPlaySimultaneousSa(activePlayerSAs);
            for (final SpellAbility sa : targeted) {
                try {
                    if (getGame().getStack().getInstanceMatchingSpellAbilityID(sa) != null || !lacksTargets(sa)) {
                        continue;
                    }
                    final String name = sa.getHostCard() == null ? "A" : sa.getHostCard().getName() + "'s";
                    if (getGui() instanceof SocketGuiGame gui) {
                        gui.tell(name + " trigger had no legal target, so it didn't go on the stack.");
                    }
                } catch (final RuntimeException ignored) {
                    // the game moved on; nothing worth reporting
                }
            }
        }

        /** Too few legal targets for this ability right now. */
        private static boolean lacksTargets(final SpellAbility sa) {
            final TargetRestrictions tgt = sa.getTargetRestrictions();
            if (tgt == null) {
                return false;
            }
            return tgt.getAllCandidates(sa).size() < tgt.getMinTargets(sa.getHostCard(), sa);
        }
    }
}

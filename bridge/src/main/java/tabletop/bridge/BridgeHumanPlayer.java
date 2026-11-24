package tabletop.bridge;

import forge.game.Game;
import forge.game.ability.ApiType;
import forge.game.card.CardCollection;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetRestrictions;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;
import org.apache.commons.lang3.tuple.ImmutablePair;

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
            flushHeldReveal();
            digs.clear();
            nextDig = List.of();
            multi = null;
            final SocketGuiGame myGui = getGui() instanceof SocketGuiGame g ? g : null;
            final boolean full = myGui != null && myGui.fullControl();
            if (!full && (passForSkip() || (myGui != null && myGui.option("autoPassOwn", false) && topIsMine()))) {
                getGui().awaitNextInput();
                return null;
            }
            final boolean stopped = full || oneTimeStop(myGui);
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
            final boolean hold = stopped || sacrificeOutletReady() || playableTop >= 0 || !preparedReady.isEmpty() || (!readyX.isEmpty() && getGame().getStack().isEmpty())
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

        /** Your own spell or ability is what resolves next. */
        private boolean topIsMine() {
            final forge.game.spellability.SpellAbilityStackInstance top = getGame().getStack().peek();
            return top != null && top.getSpellAbility().getActivatingPlayer() == getPlayer();
        }

        /** A one-time stop for this step: holds it whatever there is to do, then is taken off. */
        private boolean oneTimeStop(final SocketGuiGame gui) {
            final forge.game.phase.PhaseHandler ph = getGame().getPhaseHandler();
            if (gui == null || ph.getPhase() == null || ph.getPlayerTurn() == null || !getGame().getStack().isEmpty()) {
                return false;
            }
            final String key = ph.getTurn() + "|" + ph.getPhase();
            if (key.equals(gui.heldStop)) {
                return true;
            }
            final boolean mine = ph.isPlayerTurn(getPlayer());
            if (!"once".equals(gui.stopAt(mine, ph.getPhase()))) {
                return false;
            }
            gui.heldStop = key;
            gui.stopUsed(mine, ph.getPhase());
            return true;
        }

        /** Scries and surveils waiting on the stack (instance ids) the player chose to skip, happy with the top of the library. */
        private final java.util.Set<Integer> skipped = new java.util.HashSet<>();
        /** the top of the library they were happy with, topmost first (card ids) */
        private List<Integer> keptTop = List.of();

        @Override
        public ImmutablePair<CardCollection, CardCollection> arrangeForScry(final CardCollection topN) {
            final ImmutablePair<CardCollection, CardCollection> a = arrange(topN, ApiType.Scry, "Scry", "bottom");
            return a != null ? a : super.arrangeForScry(topN);
        }

        @Override
        public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(final CardCollection topN) {
            final ImmutablePair<CardCollection, CardCollection> a = arrange(topN, ApiType.Surveil, "Surveil", "graveyard");
            return a != null ? a : super.arrangeForSurveil(topN);
        }

        private ImmutablePair<CardCollection, CardCollection> arrange(final CardCollection topN, final ApiType api, final String verb, final String away) {
            // another player choosing for this one keeps Forge's own prompts
            if (topN.isEmpty() || !(getGui() instanceof SocketGuiGame gui)) {
                return null;
            }
            getGame().getUndoManager().barrier(verb);
            final forge.game.spellability.SpellAbilityStackInstance now =
                    getGame().getStack().isResolving() ? getGame().getStack().peek() : null;
            final CardCollection toTop = new CardCollection();
            final CardCollection toAway = new CardCollection();
            // skipped, and these are still the cards they were happy with: kept as they are
            if (now != null && skipped.contains(now.getId()) && isKept(topN)) {
                toTop.addAll(topN);
                return ImmutablePair.of(toTop, toAway);
            }
            final List<forge.game.spellability.SpellAbilityStackInstance> waiting = new ArrayList<>();
            for (final forge.game.spellability.SpellAbilityStackInstance si : getGame().getStack()) {
                if (si != now && si.getSpellAbility().getActivatingPlayer() == getPlayer() && has(si.getSpellAbility(), api)) {
                    waiting.add(si);
                }
            }
            final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
            for (final forge.game.card.Card c : topN) {
                byView.put(c.getView(), c);
            }
            final SocketGuiGame.Placed answer;
            final boolean grave = "graveyard".equals(away);
            final int n = topN.size();
            tempShowCards(topN);
            try {
                answer = gui.place(verb + " " + n, new ArrayList<>(byView.keySet()), List.of(
                        new SocketGuiGame.Place("Top of library", "top", 0, n, true, null),
                        new SocketGuiGame.Place(grave ? "Graveyard" : "Bottom of library", away, 0, n, !grave, null)), 0, verb, waiting.size());
            } finally {
                endTempShowCards();
            }
            answer.places().get(0).forEach(v -> toTop.add(byView.get(v)));
            answer.places().get(1).forEach(v -> toAway.add(byView.get(v)));
            skipped.clear();
            keptTop = List.of();
            if (answer.skip() && !toTop.isEmpty()) {
                waiting.forEach(si -> skipped.add(si.getId()));
                final List<Integer> ids = new ArrayList<>();
                toTop.forEach(c -> ids.add(c.getId()));
                keptTop = List.copyOf(ids);
            }
            return ImmutablePair.of(toTop, toAway);
        }

        // ---- the other "look at cards and put them somewhere" effects -------------------------------------

        /** cards whose order in the library was settled in a dialog already: their ids, first drawn first, and which end */
        private record Settled(List<Integer> ids, boolean top) { }

        private final List<Settled> digs = new ArrayList<>();
        /** the second pick of a two-part look (Telling Time), settled along with the first */
        private List<Integer> nextDig = List.of();

        private SocketGuiGame socketGui() {
            return getGui() instanceof SocketGuiGame g ? g : null;
        }

        private static String placeName(final forge.game.zone.ZoneType z, final boolean top) {
            return switch (z) {
                case Library -> top ? "Top of library" : "Bottom of library";
                case Hand -> "Hand";
                case Battlefield -> "Battlefield";
                case Graveyard -> "Graveyard";
                case Exile -> "Exile";
                default -> z.getTranslatedName();
            };
        }

        private static String placeKind(final forge.game.zone.ZoneType z, final boolean top) {
            return switch (z) {
                case Library -> top ? "top" : "bottom";
                case Graveyard, Exile -> "graveyard";
                case Hand, Battlefield -> "hand";
                default -> "other";
            };
        }

        private static forge.game.zone.ZoneType zoneOf(final SpellAbility sa, final String param, final forge.game.zone.ZoneType byDefault) {
            return sa.hasParam(param) ? forge.game.zone.ZoneType.smartValueOf(sa.getParam(param)) : byDefault;
        }

        private static boolean onTop(final SpellAbility sa, final String param) {
            return sa.hasParam(param) && Integer.parseInt(sa.getParam(param)) >= 0;
        }

        /**
         * "Look at the top four cards, put one into your hand and the rest on the bottom in any order": Forge asks
         * for the pick, then for the order of the rest; here it's one dialog. The cards looked at are all shown,
         * the ones that can't be picked too. Telling Time's second part (one on top, one on the bottom) joins it.
         */
        @Override
        public <T extends forge.game.GameEntity> List<T> chooseEntitiesForEffect(final forge.util.collect.FCollectionView<T> optionList, final int min, final int max,
                final forge.game.player.DelayedReveal delayedReveal, final SpellAbility sa, final String title, final Player targetedPlayer, final java.util.Map<String, Object> params) {
            final List<T> chosen = digChoice(optionList, min, max, delayedReveal, sa, targetedPlayer);
            return chosen != null ? chosen : super.chooseEntitiesForEffect(optionList, min, max, delayedReveal, sa, title, targetedPlayer, params);
        }

        private <T extends forge.game.GameEntity> List<T> digChoice(final forge.util.collect.FCollectionView<T> valid, final int min, final int max,
                final forge.game.player.DelayedReveal delayedReveal, final SpellAbility sa, final Player p) {
            final SocketGuiGame gui = socketGui();
            if (gui == null || sa == null || sa.getApi() != ApiType.Dig || p == null || valid.isEmpty() || sa.hasParam("SourceZone")
                    || sa.hasParam("FromBottom") || sa.hasParam("NoLooking") || sa.hasParam("Choser")) {
                return null;
            }
            try {
                if (!nextDig.isEmpty()) {
                    final List<T> settled = new ArrayList<>();
                    for (final int id : nextDig) {
                        for (final T t : valid) {
                            if (t.getId() == id) { settled.add(t); }
                        }
                    }
                    nextDig = List.of();
                    if (settled.size() >= min && settled.size() <= max) {
                        return settled;
                    }
                }
                final int num = forge.game.ability.AbilityUtils.calculateAmount(sa.getHostCard(), sa.getParam("DigNum"), sa);
                final CardCollection all = p.getTopXCardsFromLibrary(num);
                final boolean seesAll = delayedReveal != null || "True".equalsIgnoreCase(sa.getParam("Reveal")) || valid.size() == all.size();
                for (final T t : valid) {
                    if (!(t instanceof forge.game.card.Card c) || !all.contains(c)) {
                        return null;
                    }
                }
                if (!seesAll) {
                    return null;
                }
                final forge.game.zone.ZoneType to = zoneOf(sa, "DestinationZone", forge.game.zone.ZoneType.Hand);
                final forge.game.zone.ZoneType rest = zoneOf(sa, "DestinationZone2", forge.game.zone.ZoneType.Library);
                final boolean toTop = onTop(sa, "LibraryPosition");
                final boolean restTop = onTop(sa, "LibraryPosition2");
                final boolean random = sa.hasParam("RestRandomOrder");
                final boolean orderRest = rest == forge.game.zone.ZoneType.Library && !random && !sa.hasParam("SkipReorder");
                final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
                all.forEach(c -> byView.put(c.getView(), c));
                final java.util.Set<forge.game.card.CardView> legal = new java.util.HashSet<>();
                valid.forEach(t -> legal.add(((forge.game.card.Card) t).getView()));
                final List<SocketGuiGame.Place> places = new ArrayList<>();
                places.add(new SocketGuiGame.Place(placeName(to, toTop), placeKind(to, toTop), min, Math.min(max, all.size()),
                        to == forge.game.zone.ZoneType.Library && max > 1, legal));
                // Telling Time: what's left is looked at again, some of it to the top and the rest to the bottom
                final SpellAbility sub = sa.getSubAbility();
                int second = 0;
                if (sa.hasParam("SkipReorder") && restTop && rest == forge.game.zone.ZoneType.Library && min == max && sub != null && sub.getApi() == ApiType.Dig
                        && zoneOf(sub, "DestinationZone", forge.game.zone.ZoneType.Hand) == forge.game.zone.ZoneType.Library && onTop(sub, "LibraryPosition")
                        && zoneOf(sub, "DestinationZone2", forge.game.zone.ZoneType.Library) == forge.game.zone.ZoneType.Library && !onTop(sub, "LibraryPosition2")
                        && !sub.hasParam("ChangeValid") && all.size() == num
                        && forge.game.ability.AbilityUtils.calculateAmount(sub.getHostCard(), sub.getParam("DigNum"), sub) == num - min) {
                    second = forge.game.ability.AbilityUtils.calculateAmount(sub.getHostCard(), sub.getParamOrDefault("ChangeNum", "1"), sub);
                    places.add(new SocketGuiGame.Place("Top of library", "top", second, second, second > 1, null));
                    places.add(new SocketGuiGame.Place("Bottom of library", "bottom", 0, all.size(), true, null));
                } else {
                    final String name = placeName(rest, restTop) + (random && rest == forge.game.zone.ZoneType.Library ? " (random order)" : "");
                    places.add(new SocketGuiGame.Place(name, placeKind(rest, restTop), 0, all.size(), orderRest, null));
                }
                heldReveal = null;
                final SocketGuiGame.Placed a;
                tempShowCards(all);
                try {
                    final String host = sa.getHostCard() == null ? "" : sa.getHostCard().getTranslatedName();
                    a = gui.place(host.isEmpty() ? "Put each card somewhere" : host, new ArrayList<>(byView.keySet()), places, places.size() - 1, null, 0);
                } finally {
                    endTempShowCards();
                }
                final List<T> chosen = new ArrayList<>();
                for (final forge.game.card.CardView v : a.places().get(0)) {
                    @SuppressWarnings("unchecked") final T t = (T) byView.get(v);
                    chosen.add(t);
                }
                if (to == forge.game.zone.ZoneType.Library) {
                    digs.add(new Settled(ids(a.places().get(0)), toTop));
                }
                if (second > 0) {
                    nextDig = ids(a.places().get(1));
                    digs.add(new Settled(ids(a.places().get(1)), true));
                    digs.add(new Settled(ids(a.places().get(2)), false));
                } else if (orderRest) {
                    digs.add(new Settled(ids(a.places().get(1)), restTop));
                }
                return chosen;
            } catch (final RuntimeException e) {
                return null; // an effect put together some other way: Forge's own prompts
            }
        }

        private static List<Integer> ids(final List<forge.game.card.CardView> cards) {
            final List<Integer> out = new ArrayList<>();
            cards.forEach(c -> out.add(c.getId()));
            return out;
        }

        /**
         * Several cards going to one end of a library, in the player's order. Forge's own prompt says "closest to
         * top" for effects that put them on the bottom (Impulse), which turned the order around.
         */
        @Override
        public forge.game.card.CardCollectionView orderMoveToZoneList(final forge.game.card.CardCollectionView cards, final forge.game.zone.ZoneType destinationZone, final SpellAbility source) {
            final SocketGuiGame gui = socketGui();
            if (gui == null || destinationZone != forge.game.zone.ZoneType.Library || cards.size() < 2
                    || (source != null && source.getApi() == ApiType.ReorderZone)) {
                return super.orderMoveToZoneList(cards, destinationZone, source);
            }
            final java.util.Map<Integer, forge.game.card.Card> byId = new java.util.LinkedHashMap<>();
            cards.forEach(c -> byId.put(c.getId(), c));
            List<Integer> drawOrder = null;
            boolean top = endIsTop(source);
            for (final Settled s : digs) {
                if (s.ids().size() == byId.size() && byId.keySet().containsAll(s.ids())) {
                    drawOrder = s.ids();
                    top = s.top();
                    digs.remove(s);
                    break;
                }
            }
            if (drawOrder == null) {
                final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
                cards.forEach(c -> byView.put(c.getView(), c));
                tempShowCards(cards);
                try {
                    drawOrder = ids(gui.place(top ? "Put these on top of the library" : "Put these on the bottom of the library",
                            new ArrayList<>(byView.keySet()),
                            List.of(new SocketGuiGame.Place(top ? "Top of library" : "Bottom of library", top ? "top" : "bottom", cards.size(), cards.size(), true, null)),
                            0, null, 0).places().get(0));
                } finally {
                    endTempShowCards();
                }
            }
            // they're moved one at a time: to the top, the last one moved is the first drawn; to the bottom, the last
            final CardCollection out = new CardCollection();
            drawOrder.forEach(id -> out.add(byId.get(id)));
            if (top) {
                java.util.Collections.reverse(out);
            }
            return out;
        }

        /** Which end of the library an effect puts cards on. */
        private boolean endIsTop(final SpellAbility source) {
            if (source != null && source.getApi() == ApiType.Dig) {
                final boolean first = zoneOf(source, "DestinationZone", forge.game.zone.ZoneType.Hand) == forge.game.zone.ZoneType.Library;
                final boolean rest = zoneOf(source, "DestinationZone2", forge.game.zone.ZoneType.Library) == forge.game.zone.ZoneType.Library;
                return onTop(source, rest || !first ? "LibraryPosition2" : "LibraryPosition");
            }
            return orderedMoveToTopOfLibrary(forge.game.zone.ZoneType.Library, source);
        }

        /** Manifest dread: one of the two is manifested, the other goes to the graveyard. */
        @Override
        public <T extends forge.game.GameEntity> T chooseSingleEntityForEffect(final forge.util.collect.FCollectionView<T> optionList, final forge.game.player.DelayedReveal delayedReveal,
                final SpellAbility sa, final String title, final boolean isOptional, final Player targetedPlayer, final java.util.Map<String, Object> params) {
            final SocketGuiGame gui = socketGui();
            if (gui != null && sa != null && sa.getApi() == ApiType.ManifestDread && optionList.size() > 1) {
                final java.util.Map<forge.game.card.CardView, T> byView = new java.util.LinkedHashMap<>();
                final CardCollection cards = new CardCollection();
                for (final T t : optionList) {
                    if (t instanceof forge.game.card.Card c) {
                        byView.put(c.getView(), t);
                        cards.add(c);
                    }
                }
                tempShowCards(cards);
                try {
                    return byView.get(gui.place("Manifest dread", new ArrayList<>(byView.keySet()), List.of(
                            new SocketGuiGame.Place("Manifest face down", "hand", 1, 1, false, null),
                            new SocketGuiGame.Place("Graveyard", "graveyard", 0, cards.size(), false, null)), 1, null, 0).places().get(0).get(0));
                } finally {
                    endTempShowCards();
                }
            }
            return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
        }

        /** Cards about to be revealed to this player, held back because the dialog that follows shows them anyway. */
        private Runnable heldReveal;
        /** the stack item whose reveal was held (a later one in the same effect is shown) */
        private int heldFor = -1;

        private void flushHeldReveal() {
            final Runnable r = heldReveal;
            heldReveal = null;
            if (r != null) {
                r.run();
            }
        }

        @Override
        protected void reveal(final forge.game.card.CardCollectionView cards, final forge.game.zone.ZoneType zone, final forge.game.player.PlayerView owner, final String message, final boolean addSuffix) {
            if (socketGui() != null && !cards.isEmpty() && shownByNextChoice(cards, zone, owner)) {
                final CardCollection copy = new CardCollection(cards);
                heldReveal = () -> super.reveal(copy, zone, owner, message, addSuffix);
                return;
            }
            super.reveal(cards, zone, owner, message, addSuffix);
        }

        private boolean shownByNextChoice(final forge.game.card.CardCollectionView cards, final forge.game.zone.ZoneType zone, final forge.game.player.PlayerView owner) {
            try {
                final forge.game.zone.MagicStack stack = getGame().getStack();
                if (!stack.isResolving() || stack.peek() == null) {
                    return false;
                }
                final int item = stack.peek().getId();
                for (SpellAbility sa = stack.peekAbility(); sa != null; sa = sa.getSubAbility()) {
                    if (sa.getActivatingPlayer() != getPlayer()) {
                        continue;
                    }
                    if (sa.getApi() == ApiType.Explore && zone == forge.game.zone.ZoneType.Library && cards.size() == 1
                            && owner.getId() == getPlayer().getId() && !cards.get(0).isLand()) {
                        return true;
                    }
                    if (item == heldFor) {
                        continue;
                    }
                    if (sa.getApi() == ApiType.Dig && zone == forge.game.zone.ZoneType.Library && "True".equalsIgnoreCase(sa.getParam("Reveal"))
                            && !sa.hasParam("RandomChange") && !sa.hasParam("WithTotalCMC") && !sa.hasParam("ForEachColorPair") && !sa.hasParam("WithDifferentPowers")
                            && !sa.hasParam("SourceZone") && !sa.hasParam("FromBottom") && !sa.hasParam("Choser") && !sa.hasParam("PromptToSkipOptionalAbility")
                            && !sa.hasParam("ForceReveal") && !sa.hasParam("ForceRevealToController") && !sa.hasParam("WithMayLook")
                            && !"All".equalsIgnoreCase(sa.getParam("ChangeNum"))
                            && cards.size() == forge.game.ability.AbilityUtils.calculateAmount(sa.getHostCard(), sa.getParam("DigNum"), sa)
                            && (!sa.hasParam("ChangeValid") || !forge.game.card.CardLists.getValidCards(cards, sa.getParam("ChangeValid"), getPlayer(), sa.getHostCard(), sa).isEmpty())) {
                        heldFor = item;
                        return true;
                    }
                    if (sa.getApi() == ApiType.Discard && zone == forge.game.zone.ZoneType.Hand && owner.getId() != getPlayer().getId()
                            && ("RevealYouChoose".equals(sa.getParam("Mode")) || "LookYouChoose".equals(sa.getParam("Mode")))) {
                        heldFor = item;
                        return true;
                    }
                }
            } catch (final RuntimeException ignored) {
                // can't tell: shown as usual
            }
            return false;
        }

        /** An opponent's hand you choose from: all of it in one dialog, what can't be chosen dimmed. */
        @Override
        public forge.game.card.CardCollectionView chooseCardsToDiscardFrom(final Player p, final SpellAbility sa, final CardCollection valid, final int min, final int max,
                final forge.game.card.CardCollectionView visibleToChooser) {
            final SocketGuiGame gui = socketGui();
            if (gui == null || p == getPlayer() || visibleToChooser == null || visibleToChooser.isEmpty()) {
                return super.chooseCardsToDiscardFrom(p, sa, valid, min, max, visibleToChooser);
            }
            heldReveal = null;
            final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
            visibleToChooser.forEach(c -> byView.put(c.getView(), c));
            valid.forEach(c -> byView.putIfAbsent(c.getView(), c));
            final java.util.Set<forge.game.card.CardView> legal = new java.util.HashSet<>();
            valid.forEach(c -> legal.add(c.getView()));
            final int most = Math.min(max, valid.size());
            final String what = most == 1 ? "a card" : min == most ? most + " cards" : "up to " + most + " cards";
            final CardCollection out = new CardCollection();
            tempShowCards(byView.values());
            try {
                gui.pickAmong("Choose " + what + " for " + p.getName() + " to discard", new ArrayList<>(byView.keySet()), legal, Math.min(min, most), most)
                        .forEach(v -> out.add(byView.get(v)));
            } finally {
                endTempShowCards();
            }
            return out;
        }

        /** the cards of a "search for cards with different names", chosen in one dialog and handed over one at a time */
        private record Multi(SpellAbility sa, java.util.ArrayDeque<forge.game.card.Card> left) { }

        private Multi multi;

        @Override
        public forge.game.card.Card chooseSingleCardForZoneChange(final forge.game.zone.ZoneType destination, final List<forge.game.zone.ZoneType> origin, final SpellAbility sa,
                final CardCollection fetchList, final forge.game.player.DelayedReveal delayedReveal, final String selectPrompt, final boolean isOptional, final Player decider) {
            final SocketGuiGame gui = socketGui();
            if (gui != null && multi != null && multi.sa() == sa) {
                final forge.game.card.Card c = multi.left().poll();
                return c != null && fetchList.contains(c) ? c : null;
            }
            if (gui != null && sa != null && sa.getApi() == ApiType.ChangeZone && isOptional && sa.hasParam("DifferentNames") && !sa.hasParam("DifferentCMC")
                    && !sa.hasParam("DifferentPower") && !sa.hasParam("ShareLandType") && !sa.hasParam("WithTotalCMC") && !sa.hasParam("WithTotalPower")
                    && !sa.hasParam("WithTotalCardTypes") && selectPrompt != null && selectPrompt.matches("(?s).*\\(1 / \\d+\\)")) {
                final int num = Integer.parseInt(selectPrompt.replaceFirst("(?s).*\\(1 / (\\d+)\\)", "$1"));
                final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
                fetchList.forEach(c -> byView.put(c.getView(), c));
                final java.util.ArrayDeque<forge.game.card.Card> picked = new java.util.ArrayDeque<>();
                tempShowCards(fetchList);
                try {
                    final java.util.Set<String> names = new java.util.HashSet<>();
                    for (final forge.game.card.CardView v : gui.pickAmong("Choose up to " + num + " cards with different names", new ArrayList<>(byView.keySet()), byView.keySet(), 0, num, true)) {
                        if (names.add(byView.get(v).getName())) {
                            picked.add(byView.get(v));
                        }
                    }
                } finally {
                    endTempShowCards();
                }
                multi = new Multi(sa, picked);
                return multi.left().poll();
            }
            return super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, delayedReveal, selectPrompt, isOptional, decider);
        }

        @Override
        public boolean confirmAction(final SpellAbility sa, final forge.game.player.PlayerActionConfirmMode mode, final String message, final List<String> options,
                final forge.game.card.Card cardToShow, final java.util.Map<String, Object> params) {
            // the search above is over: they were all chosen at once, so there's nothing to confirm
            if (multi != null && multi.sa() == sa && mode == forge.game.player.PlayerActionConfirmMode.ChangeZoneGeneral) {
                multi = null;
                return true;
            }
            final SocketGuiGame gui = socketGui();
            if (gui != null && sa != null && sa.getApi() == ApiType.Explore && params != null && cardToShow != null && params.containsKey("RevealedCard")) {
                heldReveal = null;
                return !gui.place("Explore", List.of(cardToShow.getView()), List.of(
                        new SocketGuiGame.Place("Top of library", "top", 0, 1, false, null),
                        new SocketGuiGame.Place("Graveyard", "graveyard", 0, 1, false, null)), 0, null, 0).places().get(1).isEmpty();
            }
            return super.confirmAction(sa, mode, message, options, cardToShow, params);
        }

        /** Modes, chosen together in one dialog. (Pawprint modes have costs that add up: Forge's own prompts.) */
        @Override
        public List<forge.game.spellability.AbilitySub> chooseModeForAbility(final SpellAbility sa, final List<forge.game.spellability.AbilitySub> possible, final int min, final int num, final boolean allowRepeat) {
            final SocketGuiGame gui = socketGui();
            if (gui == null || sa.hasParam("Pawprint") || possible.isEmpty() || num < 1 || (!allowRepeat && min == num && num == possible.size())) {
                return super.chooseModeForAbility(sa, possible, min, num, allowRepeat);
            }
            final List<String> texts = new ArrayList<>();
            possible.forEach(m -> texts.add(m.toUnsuppressedString()));
            final int most = allowRepeat ? num : Math.min(num, possible.size());
            final int least = Math.min(min, most);
            final List<Integer> picked = new ArrayList<>(gui.modes(sa.getHostCard() == null ? null : sa.getHostCard().getView(),
                    sa.getHostCard() == null ? "Choose modes" : sa.getHostCard().getTranslatedName(), texts, least, most, allowRepeat));
            for (int i = 0; picked.size() < least; i = (i + 1) % possible.size()) {
                if (allowRepeat || !picked.contains(i)) {
                    picked.add(i);
                }
            }
            java.util.Collections.sort(picked);
            final List<forge.game.spellability.AbilitySub> out = new ArrayList<>();
            picked.forEach(i -> out.add(possible.get(i)));
            return out;
        }

        /** Delve: the cards to exile, in one pick. */
        @Override
        public forge.game.card.CardCollectionView chooseCardsToDelve(final int genericAmount, final CardCollection grave) {
            final SocketGuiGame gui = socketGui();
            final int most = Math.min(genericAmount, grave.size());
            if (gui == null || most == 0) {
                return super.chooseCardsToDelve(genericAmount, grave);
            }
            return pickCards(gui, "Delve: each card you exile pays for {1}", grave, most);
        }

        @Override
        public List<forge.game.card.Card> exertAttackers(final List<forge.game.card.Card> attackers) {
            final SocketGuiGame gui = socketGui();
            return gui == null ? super.exertAttackers(attackers) : pickCards(gui, "Exert which attackers?", attackers, attackers.size());
        }

        @Override
        public List<forge.game.card.Card> enlistAttackers(final List<forge.game.card.Card> attackers) {
            final SocketGuiGame gui = socketGui();
            return gui == null ? super.enlistAttackers(attackers) : pickCards(gui, "Enlist with which attackers?", attackers, attackers.size());
        }

        private static CardCollection pickCards(final SocketGuiGame gui, final String message, final Iterable<forge.game.card.Card> cards, final int max) {
            final java.util.Map<forge.game.card.CardView, forge.game.card.Card> byView = new java.util.LinkedHashMap<>();
            cards.forEach(c -> byView.put(c.getView(), c));
            final CardCollection out = new CardCollection();
            gui.pickAmong(message, new ArrayList<>(byView.keySet()), byView.keySet(), 0, max).forEach(v -> out.add(byView.get(v)));
            return out;
        }

        /** Whether these cards are the top of the library as the player last left it (a deeper look shows something new). */
        private boolean isKept(final Iterable<forge.game.card.Card> cards) {
            final List<Integer> ids = new ArrayList<>();
            cards.forEach(c -> ids.add(c.getId()));
            return ids.size() <= keptTop.size() && keptTop.subList(0, ids.size()).equals(ids);
        }

        /** The ability or one of its later parts does this. */
        private static boolean has(final SpellAbility sa, final ApiType api) {
            for (SpellAbility s = sa; s != null; s = s.getSubAbility()) {
                if (s.getApi() == api) {
                    return true;
                }
            }
            return false;
        }

        /**
         * The next thing to resolve is a scry or surveil the player skipped, which does nothing else, and their
         * top card hasn't changed: no need to stop for it. Anything else on top of it (an opponent's response)
         * gets priority as usual.
         */
        private boolean passForSkip() {
            if (skipped.isEmpty()) {
                return false;
            }
            final forge.game.spellability.SpellAbilityStackInstance next = getGame().getStack().peek();
            if (next == null) {
                skipped.clear();
                return false;
            }
            final SpellAbility sa = next.getSpellAbility();
            return skipped.contains(next.getId()) && sa.getSubAbility() == null && !keptTop.isEmpty()
                    && isKept(getPlayer().getCardsIn(forge.game.zone.ZoneType.Library, 1));
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
            final forge.game.card.Card twin = legendTwin(chosenSa);
            if (twin != null && getGui() instanceof SocketGuiGame gui && gui.option("warnings", true)
                    && !gui.confirm(twin.getView(), "You already control " + twin.getName() + ". The legend rule lets you keep only one of them.",
                            false, List.of("Play it anyway", "Cancel"))) {
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

        /** The legendary permanent of yours that playing this would put you over the legend rule with, or null. */
        private forge.game.card.Card legendTwin(final SpellAbility sa) {
            try {
                final forge.game.card.Card c = sa == null ? null : sa.getHostCard();
                if (c == null || !(sa.isSpell() || sa.isLandAbility()) || !c.isPermanent() || !c.getType().isLegendary() || c.isInPlay() || c.ignoreLegendRule()) {
                    return null;
                }
                for (final forge.game.card.Card mine : getPlayer().getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                    if (mine.getName().equals(c.getName()) && mine.getType().isLegendary() && !mine.ignoreLegendRule()) {
                        return mine;
                    }
                }
            } catch (final RuntimeException ignored) {
                // can't tell; no warning
            }
            return null;
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

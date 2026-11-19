package tabletop.bridge;

import com.google.common.collect.Multimap;
import com.google.common.collect.Multiset;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import forge.StaticData;
import forge.card.CardType;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.card.CardView.CardStateView;
import forge.game.card.CounterType;
import forge.game.combat.CombatView;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.game.zone.ZoneView;
import forge.gamemodes.match.Selection;
import forge.item.PaperCard;
import forge.trackable.TrackableObject;

import java.lang.reflect.RecordComponent;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;

/** Turns Forge's view objects into the JSON the 3D client renders. Hidden cards go out as ids only. */
public final class Serializer {
    private static final ZoneType[] PUBLIC_ZONES = {
            ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command
    };
    private static final Map<String, String> collectorNumbers = new ConcurrentHashMap<>();

    private Serializer() { }

    public static JsonObject game(final GameView gv, final Predicate<CardView> mayView) {
        final JsonObject o = new JsonObject();
        o.addProperty("turn", gv.getTurn());
        o.addProperty("phase", gv.getPhase() == null ? null : gv.getPhase().name());
        o.addProperty("activePlayer", gv.getPlayerTurn() == null ? null : gv.getPlayerTurn().getId());
        o.addProperty("gameOver", gv.isGameOver());
        o.addProperty("winner", gv.isGameOver() ? gv.getWinningPlayerName() : null);
        o.addProperty("commander", gv.isCommander());
        o.addProperty("mulligan", gv.isMulligan());

        final JsonArray players = new JsonArray();
        final JsonObject cards = new JsonObject();
        for (final PlayerView p : gv.getPlayers()) {
            players.add(player(p, gv, mayView, cards));
        }
        o.add("players", players);
        // cards playable from exile: only those this viewer is shown face up (an impulse-drawn card exiled face
        // down is its player's secret). Checked against the cards just serialized for them: every player's
        // exile is in there by now
        for (final JsonElement pe : players) {
            final JsonObject po = pe.getAsJsonObject();
            if (!po.has("exilePlayable")) continue;
            final JsonArray seen = new JsonArray();
            for (final JsonElement id : po.getAsJsonArray("exilePlayable")) {
                final JsonElement card = cards.get(id.getAsString());
                if (card != null && card.isJsonObject() && card.getAsJsonObject().has("visible") && card.getAsJsonObject().get("visible").getAsBoolean()) seen.add(id);
            }
            po.add("exilePlayable", seen);
        }

        final JsonArray stack = new JsonArray();
        if (gv.getStack() != null) {
            for (final StackItemView si : gv.getStack()) {
                stack.add(stackItem(si));
                putCard(cards, si.getSourceCard(), mayView);
            }
        }
        o.add("stack", stack);
        o.add("combat", combat(gv.getCombat()));
        o.add("cards", cards);
        return o;
    }

    private static JsonObject player(final PlayerView p, final GameView gv, final Predicate<CardView> mayView, final JsonObject cards) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", p.getId());
        o.addProperty("name", p.getName());
        o.addProperty("ai", p.isAI());
        o.addProperty("life", p.getLife());
        // facts read from the live game (not its view) are worked out on the game thread only: reading them
        // elsewhere races the engine (with several people at the table, views update while it runs)
        if (onGameThread()) {
            final forge.game.player.Player real = gv.getGame() == null ? null : gv.getGame().getPlayer(p);
            if (real != null) refreshLive(real);
        }
        final JsonObject facts = LIVE_PLAYER.get(p.getId());
        if (facts != null) {
            for (final java.util.Map.Entry<String, JsonElement> e : facts.entrySet()) {
                if (!"exilePlayable".equals(e.getKey())) {
                    o.add(e.getKey(), e.getValue());
                    continue;
                }
                // filtered to the cards this viewer is shown once the whole table is serialized (see game())
                o.add("exilePlayable", e.getValue().deepCopy());
            }
        }
        o.addProperty("lost", p.getHasLost());
        o.addProperty("priority", p.getHasPriority());
        o.addProperty("poison", p.getCounters(forge.game.card.CounterEnumType.POISON));
        o.add("counters", counters(p.getCounters()));

        final JsonObject mana = new JsonObject();
        // keyed the way the view stores the pool (colourless is ManaAtom's 32, not MagicColor's 0)
        for (final byte color : forge.card.mana.ManaAtom.MANATYPES) {
            final int amount = p.getMana(color);
            if (amount > 0) {
                mana.addProperty(forge.card.MagicColor.toShortString(color), amount);
            }
        }
        o.add("mana", mana);

        final JsonObject zones = new JsonObject();
        for (final ZoneType z : PUBLIC_ZONES) {
            zones.add(z.name(), zone(p.getCards(z), mayView, cards));
        }
        zones.add(ZoneType.Hand.name(), zone(p.getHand(), mayView, cards));
        zones.addProperty("LibraryCount", p.getZoneSize(ZoneType.Library));
        // the top card, when this player may see it (Bolas's Citadel, Future Sight, a card played with the top
        // revealed): sent like any visible card, and whether its owner could play it right now
        final CardView top = p.getLibrary().isEmpty() ? null : p.getLibrary().get(0);
        if (top != null && mayView.test(top)) {
            zones.addProperty("LibraryTop", top.getId());
            putCard(cards, top, mayView);
            try {
                // worked out on the game thread when you got priority (see BridgeHumanPlayer)
                if (!p.isAI() && BridgeHumanPlayer.playableTop(p.getId()) == top.getId()) {
                    zones.addProperty("LibraryTopPlayable", true);
                }
            } catch (final RuntimeException ignored) {
                // mid-update; the next snapshot says
            }
        }
        o.add("zones", zones);

        if (gv.isCommander() && p.getCommanders() != null) {
            final JsonObject cmdDamage = new JsonObject();
            for (final PlayerView other : gv.getPlayers()) {
                if (other.getCommanders() == null) { continue; }
                for (final CardView commander : other.getCommanders()) {
                    final int dmg = p.getCommanderDamage(commander);
                    if (dmg > 0) {
                        cmdDamage.addProperty(String.valueOf(commander.getId()), dmg);
                    }
                }
            }
            o.add("commanderDamage", cmdDamage);
            final JsonArray commanders = new JsonArray();
            p.getCommanders().forEach(c -> commanders.add(c.getId()));
            o.add("commanders", commanders);
        }
        return o;
    }

    private static JsonArray zone(final Iterable<CardView> zoneCards, final Predicate<CardView> mayView, final JsonObject cards) {
        final JsonArray ids = new JsonArray();
        if (zoneCards == null) {
            return ids;
        }
        for (final CardView c : zoneCards) {
            if (isBookkeeping(c)) continue;
            ids.add(c.getId());
            putCard(cards, c, mayView);
        }
        return ids;
    }

    /**
     * Forge's own bookkeeping, not a card anyone plays: the "Keyword Effects" holder it files in the command zone
     * when a player is given a keyword (K'rrik's "pay 2 life rather than {B}"), with a blank face and text that
     * reads "You has:". It keeps working in the engine; it just isn't shown.
     */
    private static boolean isBookkeeping(final CardView c) {
        return c != null && c.isImmutable() && !c.isEmblem() && "Keyword Effects".equals(c.getName());
    }

    private static void putCard(final JsonObject cards, final CardView c, final Predicate<CardView> mayView) {
        if (c == null || cards.has(String.valueOf(c.getId()))) {
            return;
        }
        cards.add(String.valueOf(c.getId()), card(c, mayView.test(c)));
        if (c.getAttachedCards() != null) {
            for (final CardView a : c.getAttachedCards()) {
                putCard(cards, a, mayView);
            }
        }
    }

    public static JsonObject card(final CardView c, final boolean visible) {
        return card(c, visible, null);
    }

    /**
     * A card as the player may see it; `face` (when not null) is shown instead of its current state: a
     * face-down card's real face, for a reveal or a look Forge allows (see cardAsShown).
     */
    public static JsonObject card(final CardView c, final boolean visible, final CardStateView face) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", c.getId());
        o.addProperty("owner", c.getOwner() == null ? null : c.getOwner().getId());
        o.addProperty("controller", c.getController() == null ? null : c.getController().getId());
        o.addProperty("zone", c.getZone() == null ? null : c.getZone().name());
        o.addProperty("tapped", c.isTapped());
        o.addProperty("visible", visible && (face != null || !c.isFaceDown()));
        if (!visible) {
            return o;
        }
        final CardStateView s = face != null ? face : c.getCurrentState();
        o.addProperty("name", s.getName());
        // tokens are printed in their set's token product (e.g. FIN → TFIN on Scryfall)
        final String[] tokenPrint = tokenPrinting(s.getImageKey());
        o.addProperty("set", tokenPrint != null ? tokenPrint[0] : s.getSetCode());
        o.addProperty("cn", tokenPrint != null ? tokenPrint[1] : collectorNumber(s.getName(), s.getSetCode()));
        o.addProperty("imageKey", s.getImageKey());
        o.addProperty("faceDown", face == null && c.isFaceDown());
        o.addProperty("state", s.getState() == null ? null : s.getState().name());
        o.addProperty("token", c.isToken());
        o.addProperty("commander", c.isCommander());
        o.addProperty("sick", c.isSick());
        o.addProperty("attacking", c.isAttacking());
        o.addProperty("blocking", c.isBlocking());
        o.addProperty("damage", c.getDamage());
        o.addProperty("manaCost", s.getManaCost() == null ? "" : s.getManaCost().toString());
        o.addProperty("typeLine", s.getType() == null ? "" : s.getType().toString());
        o.addProperty("text", face != null ? face.getOracleText() : c.getText());
        o.addProperty("creature", s.isCreature());
        o.addProperty("land", s.isLand());
        o.addProperty("planeswalker", s.isPlaneswalker());
        if (s.isCreature() && s.hasKeyword(forge.game.keyword.Keyword.FLYING)) {
            o.addProperty("flying", true);
        }
        // keywords worth seeing at a glance on the battlefield, and whether it could block at all
        final JsonArray kws = new JsonArray();
        for (final forge.game.keyword.Keyword k : SHOWN_KEYWORDS) {
            if (s.hasKeyword(k)) {
                kws.add(k.toString());
            }
        }
        // prepared (Strixhaven): a copy of the card's spell waits in exile to be cast; clicking the card casts it
        final CardView preparedSpell = c.getZone() == ZoneType.Battlefield ? c.getPreparedSpell() : null;
        if (preparedSpell != null) {
            kws.add("Prepared");
            o.addProperty("preparedSpell", preparedSpell.getCurrentState() == null ? null : preparedSpell.getCurrentState().getName());
        }
        if (!kws.isEmpty()) {
            o.add("keywords", kws);
        }
        if (s.isCreature() && c.getZone() == forge.game.zone.ZoneType.Battlefield) {
            if (onGameThread()) {
                try {
                    final forge.game.Game game = SocketGuiGame.liveGame;
                    final forge.game.card.Card real = game == null ? null : game.findById(c.getId());
                    if (real != null) CANT_BLOCK.put(c.getId(), !forge.game.combat.CombatUtil.canBlock(real, true));
                } catch (final RuntimeException ignored) {
                    // the game moved on mid-check; the next update will say
                }
            }
            if (Boolean.TRUE.equals(CANT_BLOCK.get(c.getId()))) {
                o.addProperty("cantBlock", true);
            }
        }
        if (s.isCreature() || s.hasPrintedPT()) {
            o.addProperty("power", s.getPower());
            o.addProperty("toughness", s.getToughness());
            ptBreakdown(o, c);
        }
        if (s.isPlaneswalker()) {
            o.addProperty("loyalty", s.getLoyalty());
        }
        o.add("counters", counters(c.getCounters()));
        o.addProperty("attachedTo", c.getAttachedTo() == null ? null : c.getAttachedTo().getId());
        o.addProperty("colors", s.getColors() == null ? "" : s.getColors().toString());
        return o;
    }

    /**
     * A card offered to the player in a choice or a reveal: as it really is, even when it's face down
     * (Forge only offers it because the player may see it: a reveal, looking at a face-down card), its real
     * face being the face-down card's alternate state.
     */
    public static JsonObject cardAsShown(final CardView c) {
        final CardStateView real = c.isFaceDown() ? c.getAlternateState() : null;
        return card(c, true, real != null && real.getName() != null && !real.getName().isEmpty() ? real : null);
    }

    /**
     * Where a battlefield creature's P/T comes from: its base (printed, or set by an effect like
     * "becomes a 4/4"), plus counters, plus until-end-of-turn boosts, so the client can show buffs and
     * debuffs at a glance. Omitted off the battlefield, where P/T is just the printed value.
     */
    private static void ptBreakdown(final JsonObject o, final CardView c) {
        if (c.getZone() != forge.game.zone.ZoneType.Battlefield) {
            return;
        }
        if (onGameThread()) {
            final JsonObject f = new JsonObject();
            livePtBreakdown(f, c);
            LIVE_PT.put(c.getId(), f);
        }
        final JsonObject f = LIVE_PT.get(c.getId());
        if (f != null) f.entrySet().forEach(e -> o.add(e.getKey(), e.getValue()));
    }

    private static void livePtBreakdown(final JsonObject o, final CardView c) {
        try {
            final forge.game.Game game = SocketGuiGame.liveGame;
            final forge.game.card.Card real = game == null ? null : game.findById(c.getId());
            if (real == null || !real.isCreature()) {
                return;
            }
            final forge.game.card.Card.StatBreakdown p = real.getNetPowerBreakdown();
            final forge.game.card.Card.StatBreakdown t = real.getNetToughnessBreakdown();
            o.addProperty("basePower", p.currentValue);
            o.addProperty("baseToughness", t.currentValue);
            if (p.bonusFromCounters != 0 || t.bonusFromCounters != 0) {
                o.addProperty("counterPower", p.bonusFromCounters);
                o.addProperty("counterToughness", t.bonusFromCounters);
            }
            // whatever else changed it (anthems, auras, equipment, pump spells) lands in the remainder
        } catch (final RuntimeException ignored) {
            // the game moved on mid-read; the next update will say
        }
    }

    /** live-game facts per player / card, as last worked out on the game thread (see onGameThread) */
    private static final java.util.Map<Integer, JsonObject> LIVE_PLAYER = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Map<Integer, Boolean> CANT_BLOCK = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Map<Integer, JsonObject> LIVE_PT = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * Whether this is a game thread (Forge names them Game-N). Only there is it safe to read the live game
     * rather than its views: elsewhere the engine may be changing it underneath (a ConcurrentModificationException
     * there kills the game thread, as in Forge's undo checkpoint).
     */
    static boolean onGameThread() {
        return Thread.currentThread().getName().startsWith("Game-");
    }

    /** A new game: nothing carried over (ids are reused). */
    /** per player: the exiled cards they've been allowed to play, with the last of their own turns each was playable */
    private static final java.util.Map<Integer, java.util.Map<Integer, Integer>> EXILE_PLAYABLE = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * The exiled cards (in anyone's exile) this player may play: impulse draw, Tinybones' stash, adventures. Some
     * are only playable on their own turn (Tinybones), so cards stay listed between turns. Each is remembered with
     * the last turn it was playable; on the player's own turn, once their first main phase is over, a card that
     * hasn't been playable at any point that turn (an impulse draw that ran out) drops off. Forge clears and
     * re-grants these permissions while it updates continuous effects, so a moment where nothing is playable
     * must not empty the list. Anything that leaves exile goes. Game thread only.
     */
    /**
     * Works out a player's live-game facts (see LIVE_PLAYER). Game thread only. Snapshots are often built on
     * the display thread, which reuses these, so they're also refreshed whenever a person gets priority
     * (refreshLive(Game)): what's on screen while the game waits for you is never older than that.
     */
    static void refreshLive(final forge.game.player.Player real) {
        final JsonObject f = new JsonObject();
        try {
            // Forge's game turn counts every player's turns; players think in their own ("my third turn")
            f.addProperty("turns", real.getTurn());
            // what they could spend right now: untapped sources (net of activation costs) plus floating mana
            f.addProperty("manaAvailable", manaAvailable(real));
            // their commanders' combined colour identity, WUBRG order ("" for colourless); the table tints their mat's cracks
            final forge.card.ColorSet identity = real.getCommanderColorID();
            if (identity != null) {
                final StringBuilder wubrg = new StringBuilder();
                for (final byte color : forge.card.MagicColor.WUBRG) {
                    if (identity.hasAnyColor(color)) { wubrg.append(forge.card.MagicColor.toShortString(color)); }
                }
                f.addProperty("identity", wubrg.toString());
            }
            f.add("exilePlayable", exilePlayable(real));
        } catch (RuntimeException ignored) {
            // mid-update; the next refresh carries it
        }
        LIVE_PLAYER.put(real.getId(), f);
    }

    /** Every player's live facts at once (game thread only). */
    static void refreshLive(final forge.game.Game game) {
        if (game == null) return;
        for (final forge.game.player.Player pl : game.getPlayers()) refreshLive(pl);
    }

    private static JsonArray exilePlayable(final forge.game.player.Player player) {
        final forge.game.Game game = player.getGame();
        // counted in the player's own turns: the game's turn number moves on a moment before the turn passes to
        // the next player, which would otherwise look like "your turn, and none of these playable this turn"
        final int turn = player.getTurn();
        final java.util.Set<Integer> inExile = new java.util.HashSet<>();
        final java.util.Map<Integer, Integer> kept = EXILE_PLAYABLE.computeIfAbsent(player.getId(), k -> new java.util.LinkedHashMap<>());
        final JsonArray out = new JsonArray();
        synchronized (kept) {
            for (final forge.game.player.Player owner : game.getPlayers()) {
                for (final forge.game.card.Card c : owner.getCardsIn(ZoneType.Exile)) {
                    inExile.add(c.getId());
                    if (!c.mayPlay(player).isEmpty()) kept.put(c.getId(), turn);
                }
            }
            kept.keySet().retainAll(inExile);
            final forge.game.phase.PhaseType phase = game.getPhaseHandler().getPhase();
            if (game.getPhaseHandler().isPlayerTurn(player) && phase != null && phase.isAfter(forge.game.phase.PhaseType.MAIN1)) {
                kept.values().removeIf(t -> t != turn);
            }
            kept.keySet().forEach(out::add);
            // cards one of your permanents lets you play even while that's switched off right now (Tinybones:
            // "during your turn"), so a card stashed on an opponent's turn joins the band straight away
            for (final forge.game.player.Player owner : game.getPlayers()) {
                for (final forge.game.card.Card c : owner.getCardsIn(ZoneType.Exile)) {
                    if (!kept.containsKey(c.getId()) && grantedPlayFromExile(player, c)) out.add(c.getId());
                }
            }
        }
        return out;
    }

    /** Whether a continuous "you may play" effect of one of this player's permanents (or emblems) covers this exiled card, conditions aside. */
    private static boolean grantedPlayFromExile(final forge.game.player.Player player, final forge.game.card.Card exiled) {
        for (final ZoneType z : new ZoneType[]{ZoneType.Battlefield, ZoneType.Command}) {
            for (final forge.game.card.Card host : player.getCardsIn(z)) {
                for (final forge.game.staticability.StaticAbility st : host.getStaticAbilities()) {
                    if (!st.checkMode(forge.game.staticability.StaticAbilityMode.Continuous) || !st.hasParam("MayPlay") || !st.hasParam("Affected")) continue;
                    final String zones = st.getParamOrDefault("AffectedZone", "");
                    if (!zones.contains("Exile")) continue;
                    try {
                        if (st.matchesValidParam("Affected", exiled)) return true;
                    } catch (final RuntimeException ignored) {
                        // a condition we can't evaluate here
                    }
                }
            }
        }
        return false;
    }

    static void resetLive() {
        EXILE_PLAYABLE.clear();
        LIVE_PLAYER.clear();
        CANT_BLOCK.clear();
        LIVE_PT.clear();
    }

    private static String collectorNumber(final String name, final String set) {
        if (name == null || set == null) {
            return null;
        }
        final String key = name + "|" + set;
        final String cached = collectorNumbers.get(key);
        if (cached != null) {
            return cached.isEmpty() ? null : cached;
        }
        String cn = "";
        try {
            final PaperCard pc = StaticData.instance().getCommonCards().getCard(name, set);
            if (pc != null && pc.getCollectorNumber() != null) {
                cn = pc.getCollectorNumber();
            }
        } catch (RuntimeException ignored) {
            // tokens and oddities aren't in the common card DB
        }
        collectorNumbers.put(key, cn);
        return cn.isEmpty() ? null : cn;
    }

    private static final forge.game.keyword.Keyword[] SHOWN_KEYWORDS = {
        forge.game.keyword.Keyword.HASTE, forge.game.keyword.Keyword.VIGILANCE, forge.game.keyword.Keyword.TRAMPLE,
        forge.game.keyword.Keyword.DEATHTOUCH, forge.game.keyword.Keyword.LIFELINK, forge.game.keyword.Keyword.FIRST_STRIKE,
        forge.game.keyword.Keyword.DOUBLE_STRIKE, forge.game.keyword.Keyword.REACH, forge.game.keyword.Keyword.MENACE,
        forge.game.keyword.Keyword.HEXPROOF, forge.game.keyword.Keyword.INDESTRUCTIBLE, forge.game.keyword.Keyword.DEFENDER,
    };

    private static final java.util.Map<String, String[]> tokenPrints = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * A token's image key is "t:name|SET[|number]". Its art lives in the set's token product on Scryfall:
     * returns {token set code, collector number}, or null when Forge doesn't know a printing.
     */
    static String[] tokenPrinting(final String imageKey) {
        if (imageKey == null || !imageKey.startsWith("t:")) {
            return null;
        }
        final String[] cached = tokenPrints.get(imageKey);
        if (cached != null) {
            return cached.length == 0 ? null : cached;
        }
        String[] out = new String[0];
        try {
            String key = imageKey.substring(2);
            if (key.endsWith(forge.ImageKeys.BACKFACE_POSTFIX)) {
                key = key.substring(0, key.length() - forge.ImageKeys.BACKFACE_POSTFIX.length());
            }
            final String[] parts = key.split("\\|");
            if (parts.length >= 2) {
                final forge.card.CardEdition ed = StaticData.instance().getEditions().get(parts[1]);
                if (ed != null && ed.getTokensCode() != null) {
                    String cn = parts.length > 2 ? parts[2] : null;
                    if (cn == null || cn.isEmpty()) {
                        for (final forge.card.CardEdition.EditionEntry e : ed.getTokens().get(parts[0])) {
                            if (e.collectorNumber() != null && !e.collectorNumber().isEmpty()) {
                                cn = e.collectorNumber();
                                break;
                            }
                        }
                    }
                    if (cn != null && !cn.isEmpty()) {
                        out = new String[] {ed.getTokensCode(), cn.replace("\u2607", "")};
                    }
                }
            }
        } catch (RuntimeException ignored) {
            // unknown edition or malformed key: the client falls back to a search by name
        }
        tokenPrints.put(imageKey, out);
        return out.length == 0 ? null : out;
    }

    private static JsonObject counters(final Multiset<CounterType> counters) {
        final JsonObject o = new JsonObject();
        if (counters != null) {
            for (final Multiset.Entry<CounterType> e : counters.entrySet()) {
                o.addProperty(e.getElement().getName(), e.getCount());
            }
        }
        return o;
    }

    private static JsonObject stackItem(final StackItemView si) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", si.getId());
        o.addProperty("text", si.getText());
        o.addProperty("source", si.getSourceCard() == null ? null : si.getSourceCard().getId());
        o.addProperty("controller", si.getActivatingPlayer() == null ? null : si.getActivatingPlayer().getId());
        o.addProperty("ability", si.isAbility());
        o.addProperty("trigger", si.isTrigger());
        final JsonArray targets = new JsonArray();
        if (si.getTargetCards() != null) { si.getTargetCards().forEach(t -> targets.add(ref(t))); }
        if (si.getTargetPlayers() != null) { si.getTargetPlayers().forEach(t -> targets.add(ref(t))); }
        o.add("targets", targets);
        return o;
    }

    private static JsonElement combat(final CombatView combat) {
        if (combat == null) {
            return JsonNull.INSTANCE;
        }
        final JsonArray attacks = new JsonArray();
        for (final CardView attacker : combat.getAttackers()) {
            final JsonObject a = new JsonObject();
            a.addProperty("attacker", attacker.getId());
            a.add("defender", ref(combat.getDefender(attacker)));
            // while blocks are being declared they're only "planned"; show those too
            final JsonArray blockers = new JsonArray();
            var list = combat.getBlockers(attacker);
            if (list == null || list.isEmpty()) {
                list = combat.getPlannedBlockers(attacker);
            }
            if (list != null) {
                list.forEach(b -> blockers.add(b.getId()));
            }
            a.add("blockers", blockers);
            attacks.add(a);
        }
        return attacks;
    }

    public static JsonObject selection(final Selection sel) {
        final JsonObject o = new JsonObject();
        final JsonArray cards = new JsonArray();
        sel.cards().forEach(c -> cards.add(c.getId()));
        o.add("cards", cards);
        o.addProperty("min", sel.min());
        o.addProperty("max", sel.max());
        final JsonArray targets = new JsonArray();
        sel.targets().forEach(t -> targets.add(ref(t)));
        o.add("targets", targets);
        final JsonArray chosen = new JsonArray();
        sel.chosen().forEach(t -> chosen.add(ref(t)));
        o.add("chosen", chosen);
        final JsonArray actionable = new JsonArray();
        sel.actionable().forEach(c -> actionable.add(c.getId()));
        o.add("actionable", actionable);
        return o;
    }

    /**
     * Mana a player could make right now, read without evaluating anything (this runs off the game thread):
     * each untapped source's best mana ability that costs only {T} or nothing (skipping summoning-sick
     * creatures that need to tap), plus floating mana. Sacrifice outlets and abilities that cost mana aren't counted.
     */
    static int manaAvailable(final forge.game.player.Player player) {
        int total = player.getManaPool().totalMana();
        for (final forge.game.card.Card c : player.getCardsIn(ZoneType.Battlefield).threadSafeIterable()) {
            int best = 0;
            for (final forge.game.spellability.SpellAbility ma : c.getManaAbilities()) {
                final forge.game.cost.Cost cost = ma.getPayCosts();
                boolean ok = true;
                boolean taps = false;
                if (cost != null) {
                    for (final forge.game.cost.CostPart part : cost.getCostParts()) {
                        if (part instanceof forge.game.cost.CostTap) {
                            taps = true;
                        } else {
                            ok = false;
                        }
                    }
                }
                if (!ok || (taps && (c.isTapped() || (c.isCreature() && c.isSick())))) {
                    continue;
                }
                try {
                    int made = 0;
                    for (forge.game.spellability.SpellAbility part = ma; part != null; part = part.getSubAbility()) {
                        if (part.getManaPart() == null) {
                            continue;
                        }
                        // "Produced$ W W" makes two; "Amount$ 2" multiplies (Sol Ring)
                        final String produced = part.getParamOrDefault("Produced", "1").trim();
                        final int symbols = produced.startsWith("Combo") || produced.startsWith("Any") ? 1 : Math.max(1, produced.split("\\s+").length);
                        made += symbols * Math.max(1, parseAmount(part.getParamOrDefault("Amount", "1")));
                    }
                    best = Math.max(best, made);
                } catch (final RuntimeException ignored) {
                    best = Math.max(best, 1);
                }
            }
            total += best;
        }
        return total;
    }

    private static int parseAmount(final String amount) {
        try {
            return Integer.parseInt(amount.trim());
        } catch (final NumberFormatException e) {
            return 1; // "X" and the like: at least one
        }
    }

    /**
     * Whether a player could play this card right now: a land drop or a spell/ability they can afford and
     * target (Forge's own available-actions test, which only looks at hand and battlefield).
     */
    public static boolean playableNow(final forge.game.card.Card card, final forge.game.player.Player player) {
        for (final forge.game.spellability.SpellAbility sa : card.getAllPossibleAbilities(player, true)) {
            if (sa.isManaAbility()) {
                continue;
            }
            final boolean affordable = sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()
                    || forge.ai.ComputerUtilMana.canPayManaCost(sa, player, 0, false);
            if (affordable && forge.ai.ComputerUtilAbility.isFullyTargetable(sa)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Battlefield cards of this player with an activated ability whose targets depend on X (Chthonian
     * Nightmare: a creature card with mana value X). Forge's available-actions test checks targets with X = 0
     * and so misses them; here every X the player could choose is tried.
     */
    public static java.util.List<Integer> readyXAbilities(final forge.game.player.Player player) {
        final java.util.List<Integer> ids = new java.util.ArrayList<>();
        for (final forge.game.card.Card c : player.getCardsIn(ZoneType.Battlefield)) {
            for (final forge.game.spellability.SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                if (sa.isManaAbility() || !sa.usesTargeting() || sa.getPayCosts() == null || !sa.getPayCosts().hasXInAnyCostPart()) {
                    continue;
                }
                final Integer before = sa.getXManaCostPaid();
                try {
                    final org.apache.commons.lang3.Range<Integer> range = forge.game.ability.AbilityUtils.getAnnouncementBounds(sa, "X");
                    final int max = Math.min(range.getMaximum(), 20);
                    for (int x = Math.max(0, range.getMinimum()); x <= max; x++) {
                        sa.setXManaCostPaid(x);
                        if (sa.getTargetRestrictions().getAllCandidates(sa).size() >= Math.max(1, sa.getTargetRestrictions().getMinTargets(c, sa))
                                && forge.game.cost.CostPayment.canPayAdditionalCosts(sa.getPayCosts(), sa, false)) {
                            ids.add(c.getId());
                            break;
                        }
                    }
                } catch (final RuntimeException ignored) {
                    // can't tell for this one
                } finally {
                    sa.setXManaCostPaid(before);
                }
                if (ids.contains(c.getId())) {
                    break;
                }
            }
        }
        return ids;
    }

    /**
     * Cards in exile this player could play right now. Forge's own "you could play this" scan never looks in
     * exile (only hand, battlefield and flashback), so stash cards, impulse draws and the like never lit up.
     * Spells cast with "mana of any type" (Tinybones, Gonti, heist) are checked against the total mana you
     * could make, since the colours don't matter; anything else asks Forge whether the cost can be paid.
     * Game thread only.
     */
    public static java.util.List<Integer> exileReady(final forge.game.player.Player player) {
        final java.util.List<Integer> ids = new java.util.ArrayList<>();
        final forge.game.Game game = player.getGame();
        int available = -1;
        for (final forge.game.player.Player owner : game.getPlayers()) {
            for (final forge.game.card.Card c : owner.getCardsIn(ZoneType.Exile)) {
                final java.util.List<forge.game.card.CardPlayOption> options = c.mayPlay(player);
                if (options.isEmpty()) continue;
                boolean anyMana = false;
                for (final forge.game.card.CardPlayOption o : options) {
                    if (o.isIgnoreManaCostType() || o.isIgnoreManaCostColor()) anyMana = true;
                }
                try {
                    for (final forge.game.spellability.SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                        if (sa.isManaAbility() || !forge.ai.ComputerUtilAbility.isFullyTargetable(sa)) continue;
                        final forge.game.cost.Cost cost = sa.getPayCosts();
                        boolean affordable;
                        if (cost == null || !cost.hasManaCost()) {
                            affordable = true;
                        } else {
                            if (available < 0) available = manaAvailable(player);
                            final int needed = cost.getTotalMana().getCMC();
                            if (anyMana) {
                                affordable = available >= needed;
                            } else {
                                try {
                                    affordable = forge.ai.ComputerUtilMana.canPayManaCost(sa, player, 0, false);
                                } catch (final RuntimeException e) {
                                    affordable = available >= needed;
                                }
                            }
                        }
                        if (affordable) {
                            ids.add(c.getId());
                            break;
                        }
                    }
                } catch (final RuntimeException ignored) {
                    // can't tell for this one
                }
            }
        }
        return ids;
    }

    /** What {@link #usableNow} found: the cards, and whether it ran out of time before looking at them all. */
    record UsableScan(java.util.List<Integer> cards, boolean incomplete) { }

    private static final ZoneType[] OWN_PLAY_ZONES = { ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Command, ZoneType.Exile };

    /**
     * Cards in this player's hand, battlefield, graveyard, command zone and exile with a spell or ability they
     * could use right now. It's a broader test than Forge's own "anything to do?" check, which auto-pass relies on:
     * that check pays costs with the AI's mana planner, and the planner says no to costs a person can pay
     * (Phyrexian symbols or K'rrik's {B} paid with life, mana it won't plan with). Where the planner says no, the
     * mana on hand is counted roughly instead. Timing, targets and other costs are Forge's own tests. Cards in
     * other players' exiles are {@link #exileReady}'s. Runs on the game thread; stops after budgetMs (and says so).
     */
    static UsableScan usableNow(final forge.game.player.Player player, final long budgetMs) {
        final java.util.List<Integer> ids = new java.util.ArrayList<>();
        final long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        for (final ZoneType zone : OWN_PLAY_ZONES) {
            for (final forge.game.card.Card c : player.getCardsIn(zone)) {
                if (System.nanoTime() > deadline) {
                    return new UsableScan(ids, true);
                }
                try {
                    if (usable(c, player)) {
                        ids.add(c.getId());
                    }
                } catch (final RuntimeException ignored) {
                    // can't tell for this one
                }
            }
        }
        return new UsableScan(ids, false);
    }

    private static boolean usable(final forge.game.card.Card c, final forge.game.player.Player player) {
        for (final forge.game.spellability.SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
            if (sa.isManaAbility() || sa.isLandAbility() || !forge.ai.ComputerUtilAbility.isFullyTargetable(sa)) {
                continue;
            }
            final forge.game.cost.Cost cost = sa.getPayCosts();
            if (cost == null || !cost.hasManaCost()) {
                return true;
            }
            try {
                if (forge.ai.ComputerUtilMana.canPayManaCost(sa, player, 0, false)) {
                    return true;
                }
            } catch (final RuntimeException ignored) {
                // the planner gave up; the rough count decides
            }
            if (roughlyAffordable(sa, player)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether the mana on hand could plausibly pay this ability's mana cost: enough untapped sources and floating
     * mana for what's left once the symbols payable with life are set aside (Phyrexian ones, and {B} under K'rrik),
     * and for each coloured symbol left, a source (or the pool) that makes one of its colours. Generous on purpose:
     * it decides whether to stop for the player, and a needless stop costs a click where a missed one costs a game.
     */
    static boolean roughlyAffordable(final forge.game.spellability.SpellAbility sa, final forge.game.player.Player player) {
        final forge.card.mana.ManaCost cost = sa.getPayCosts().getTotalMana();
        final boolean lifeForBlack = player.hasKeyword("PayLifeInsteadOf:B");
        int lifeSymbols = player.canPayLife(2, false, sa) ? Math.max(0, (player.getLife() - 1) / 2) : 0;
        int needed = cost.getGenericCost();
        final java.util.List<Byte> colourNeeds = new java.util.ArrayList<>();
        for (final forge.card.mana.ManaCostShard shard : cost) {
            if (shard == forge.card.mana.ManaCostShard.X) {
                continue;
            }
            final boolean byLife = shard.isPhyrexian() || (lifeForBlack && shard.getColorMask() == forge.card.MagicColor.BLACK);
            if (byLife && lifeSymbols > 0) {
                lifeSymbols--;
                continue;
            }
            needed++;
            // {2/W} and the like can be paid with generic mana; only plain coloured and hybrid symbols ask for a colour
            if (!shard.isOr2Generic() && shard.getColorMask() != 0) {
                colourNeeds.add(shard.getColorMask());
            }
        }
        if (needed == 0) {
            return true;
        }
        if (manaAvailable(player) < needed) {
            return false;
        }
        final byte makes = coloursAvailable(player);
        for (final byte need : colourNeeds) {
            if ((need & makes) == 0) {
                return false;
            }
        }
        return true;
    }

    /** The colours this player could make right now: floating in the pool, or from a source they could tap. */
    private static byte coloursAvailable(final forge.game.player.Player player) {
        byte mask = 0;
        for (final byte colour : forge.card.MagicColor.WUBRG) {
            if (player.getManaPool().getAmountOfColor(colour) > 0) {
                mask |= colour;
            }
        }
        for (final forge.game.card.Card c : player.getCardsIn(ZoneType.Battlefield)) {
            for (final forge.game.spellability.SpellAbility ma : c.getManaAbilities()) {
                final forge.game.cost.Cost cost = ma.getPayCosts();
                if (cost != null && cost.hasTapCost() && (c.isTapped() || (c.isCreature() && c.isSick()))) {
                    continue;
                }
                try {
                    for (forge.game.spellability.SpellAbility part = ma; part != null; part = part.getSubAbility()) {
                        if (part.getManaPart() == null) {
                            continue;
                        }
                        for (final byte colour : forge.card.MagicColor.WUBRG) {
                            if (part.getManaPart().canProduce(forge.card.MagicColor.toShortString(colour), part)) {
                                mask |= colour;
                            }
                        }
                    }
                } catch (final RuntimeException ignored) {
                    // a source we can't read
                }
            }
        }
        return mask;
    }

    /** Whether every mana ability of this card has a sacrifice in its cost (Lotus Petal, Treasure, Phyrexian Altar). */
    public static boolean manaCostsSacrifice(final forge.game.card.Card card) {
        if (card == null || card.getManaAbilities().isEmpty()) {
            return false;
        }
        for (final forge.game.spellability.SpellAbility sa : card.getManaAbilities()) {
            if (sa.getPayCosts() == null || !sa.getPayCosts().hasSpecificCostType(forge.game.cost.CostSacrifice.class)) {
                return false;
            }
        }
        return true;
    }

    /** A typed reference to a game object, so the client knows which table to look in. */
    public static JsonElement ref(final Object obj) {
        if (obj == null) {
            return JsonNull.INSTANCE;
        }
        final JsonObject o = new JsonObject();
        if (obj instanceof CardView c) {
            o.addProperty("card", c.getId());
        } else if (obj instanceof PlayerView p) {
            o.addProperty("player", p.getId());
        } else if (obj instanceof StackItemView s) {
            o.addProperty("stack", s.getId());
        } else if (obj instanceof SpellAbilityView sa) {
            o.addProperty("ability", sa.getId());
        } else if (obj instanceof GameEntityView e) {
            o.addProperty("entity", e.getId());
        } else if (obj instanceof TrackableObject t) {
            o.addProperty("object", t.getId());
        } else {
            return new JsonPrimitive(String.valueOf(obj));
        }
        return o;
    }

    /** Game events are records, so their components map straight onto JSON fields. */
    public static JsonObject event(final Object event) {
        final JsonObject o = new JsonObject();
        o.addProperty("event", event.getClass().getSimpleName().replaceFirst("^GameEvent", ""));
        if (event.getClass().isRecord()) {
            for (final RecordComponent rc : event.getClass().getRecordComponents()) {
                try {
                    o.add(rc.getName(), value(rc.getAccessor().invoke(event), 0));
                } catch (ReflectiveOperationException | RuntimeException ignored) {
                    // a component we can't read just stays off the wire
                }
            }
        }
        return o;
    }

    private static JsonElement value(final Object v, final int depth) {
        if (v == null || depth > 3) {
            return JsonNull.INSTANCE;
        }
        if (v instanceof Number n) { return new JsonPrimitive(n); }
        if (v instanceof Boolean b) { return new JsonPrimitive(b); }
        if (v instanceof CharSequence s) { return new JsonPrimitive(s.toString()); }
        if (v instanceof Enum<?> e) { return new JsonPrimitive(e.name()); }
        if (v instanceof TrackableObject) { return ref(v); }
        if (v instanceof ZoneView zv) {
            final JsonObject o = new JsonObject();
            o.addProperty("player", zv.player() == null ? null : zv.player().getId());
            o.addProperty("zone", zv.zoneType() == null ? null : zv.zoneType().name());
            return o;
        }
        if (v instanceof Multimap<?, ?> mm) {
            final JsonArray arr = new JsonArray();
            for (final Map.Entry<?, ?> e : mm.entries()) {
                final JsonObject pair = new JsonObject();
                pair.add("key", value(e.getKey(), depth + 1));
                pair.add("value", value(e.getValue(), depth + 1));
                arr.add(pair);
            }
            return arr;
        }
        if (v instanceof Map<?, ?> m) {
            final JsonArray arr = new JsonArray();
            for (final Map.Entry<?, ?> e : m.entrySet()) {
                final JsonObject pair = new JsonObject();
                pair.add("key", value(e.getKey(), depth + 1));
                pair.add("value", value(e.getValue(), depth + 1));
                arr.add(pair);
            }
            return arr;
        }
        if (v instanceof Iterable<?> it) {
            final JsonArray arr = new JsonArray();
            for (final Object x : it) {
                arr.add(value(x, depth + 1));
            }
            return arr;
        }
        if (v instanceof CardType || v instanceof forge.card.CardTypeView) {
            return new JsonPrimitive(v.toString());
        }
        return new JsonPrimitive(v.toString());
    }
}

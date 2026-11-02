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
        // Forge's game turn counts every player's turns; players think in their own ("my third turn")
        try {
            final forge.game.player.Player real = gv.getGame() == null ? null : gv.getGame().getPlayer(p);
            if (real != null) {
                o.addProperty("turns", real.getTurn());
                // what they could spend right now: untapped sources (net of activation costs) plus floating mana
                o.addProperty("manaAvailable", manaAvailable(real));
            }
        } catch (RuntimeException ignored) {
            // view mid-update; the next snapshot carries it
        }
        o.addProperty("lost", p.getHasLost());
        o.addProperty("priority", p.getHasPriority());
        o.addProperty("poison", p.getCounters(forge.game.card.CounterEnumType.POISON));
        o.add("counters", counters(p.getCounters()));

        final JsonObject mana = new JsonObject();
        for (final byte color : forge.card.MagicColor.WUBRGC) {
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
                if (!p.isAI() && BridgeHumanPlayer.playableTop == top.getId()) {
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
            ids.add(c.getId());
            putCard(cards, c, mayView);
        }
        return ids;
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
        final JsonObject o = new JsonObject();
        o.addProperty("id", c.getId());
        o.addProperty("owner", c.getOwner() == null ? null : c.getOwner().getId());
        o.addProperty("controller", c.getController() == null ? null : c.getController().getId());
        o.addProperty("zone", c.getZone() == null ? null : c.getZone().name());
        o.addProperty("tapped", c.isTapped());
        o.addProperty("visible", visible && !c.isFaceDown());
        if (!visible) {
            return o;
        }
        final CardStateView s = c.getCurrentState();
        o.addProperty("name", s.getName());
        // tokens are printed in their set's token product (e.g. FIN → TFIN on Scryfall)
        final String[] tokenPrint = tokenPrinting(s.getImageKey());
        o.addProperty("set", tokenPrint != null ? tokenPrint[0] : s.getSetCode());
        o.addProperty("cn", tokenPrint != null ? tokenPrint[1] : collectorNumber(s.getName(), s.getSetCode()));
        o.addProperty("imageKey", s.getImageKey());
        o.addProperty("faceDown", c.isFaceDown());
        o.addProperty("state", s.getState() == null ? null : s.getState().name());
        o.addProperty("token", c.isToken());
        o.addProperty("commander", c.isCommander());
        o.addProperty("sick", c.isSick());
        o.addProperty("attacking", c.isAttacking());
        o.addProperty("blocking", c.isBlocking());
        o.addProperty("damage", c.getDamage());
        o.addProperty("manaCost", s.getManaCost() == null ? "" : s.getManaCost().toString());
        o.addProperty("typeLine", s.getType() == null ? "" : s.getType().toString());
        o.addProperty("text", c.getText());
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
        if (!kws.isEmpty()) {
            o.add("keywords", kws);
        }
        if (s.isCreature() && c.getZone() == forge.game.zone.ZoneType.Battlefield) {
            try {
                final forge.game.Game game = SocketGuiGame.liveGame;
                final forge.game.card.Card real = game == null ? null : game.findById(c.getId());
                if (real != null && !forge.game.combat.CombatUtil.canBlock(real, true)) {
                    o.addProperty("cantBlock", true);
                }
            } catch (final RuntimeException ignored) {
                // the game moved on mid-check; the next update will say
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
     * Where a battlefield creature's P/T comes from: its base (printed, or set by an effect like
     * "becomes a 4/4"), plus counters, plus until-end-of-turn boosts, so the client can show buffs and
     * debuffs at a glance. Omitted off the battlefield, where P/T is just the printed value.
     */
    private static void ptBreakdown(final JsonObject o, final CardView c) {
        if (c.getZone() != forge.game.zone.ZoneType.Battlefield) {
            return;
        }
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

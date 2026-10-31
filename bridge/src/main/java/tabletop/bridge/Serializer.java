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
            if (real != null) { o.addProperty("turns", real.getTurn()); }
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
        o.addProperty("set", s.getSetCode());
        o.addProperty("cn", collectorNumber(s.getName(), s.getSetCode()));
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
        if (s.isCreature() || s.hasPrintedPT()) {
            o.addProperty("power", s.getPower());
            o.addProperty("toughness", s.getToughness());
        }
        if (s.isPlaneswalker()) {
            o.addProperty("loyalty", s.getLoyalty());
        }
        o.add("counters", counters(c.getCounters()));
        o.addProperty("attachedTo", c.getAttachedTo() == null ? null : c.getAttachedTo().getId());
        o.addProperty("colors", s.getColors() == null ? "" : s.getColors().toString());
        return o;
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

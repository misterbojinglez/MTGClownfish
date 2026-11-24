package tabletop.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.event.GameEvent;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventSpellResolved;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.List;

/**
 * Spots a spell being countered, for the client's counterspell effect. Forge has no event for it: a counter
 * resolves (an ability whose effect, or a sub-ability's, is Counter) and the spells it counters leave the Stack
 * while it does. Seeing a card leave the Stack while such an ability is resolving, then that ability finish
 * without fizzling, makes a {@code SpellCountered} event. "Counter unless its controller pays" that was paid
 * moves nothing, so it makes none. Runs on the game thread, from the match's event subscriber.
 */
final class Counters {
    private Counters() { }

    private static SpellAbility resolving;
    private static final List<Integer> moved = new ArrayList<>();

    static JsonObject watch(final Game game, final GameEvent event) {
        if (game == null) return null;
        try {
            if (event instanceof GameEventCardChangeZone cz && cz.from() != null && cz.from().zoneType() == ZoneType.Stack) {
                final SpellAbility sa = game.getStack().getResolvingAbility();
                if (sa == null || !counters(sa)) return null;
                final Card host = sa.getHostCard();
                if (cz.card() == null || (host != null && host.getId() == cz.card().getId())) return null;
                if (resolving != sa) {
                    resolving = sa;
                    moved.clear();
                }
                moved.add(cz.card().getId());
                return null;
            }
            if (event instanceof GameEventSpellResolved r) {
                final SpellAbility sa = game.getStack().getResolvingAbility();
                final boolean hit = sa != null && sa == resolving && !moved.isEmpty() && !r.hasFizzled();
                final List<Integer> cards = new ArrayList<>(moved);
                resolving = null;
                moved.clear();
                if (!hit) return null;
                final JsonObject o = new JsonObject();
                o.addProperty("event", "SpellCountered");
                final Card host = sa.getHostCard();
                if (host != null) {
                    final JsonObject src = new JsonObject();
                    src.addProperty("card", host.getId());
                    o.add("source", src);
                }
                if (sa.getActivatingPlayer() != null) o.addProperty("controller", sa.getActivatingPlayer().getId());
                final JsonArray arr = new JsonArray();
                for (final int id : cards) {
                    final JsonObject c = new JsonObject();
                    c.addProperty("card", id);
                    arr.add(c);
                }
                o.add("countered", arr);
                return o;
            }
        } catch (final RuntimeException e) {
            // never let the effect's bookkeeping get in the game's way
            resolving = null;
            moved.clear();
        }
        return null;
    }

    /** Whether this ability, or one chained under it, counters something. */
    private static boolean counters(final SpellAbility sa) {
        for (SpellAbility s = sa; s != null; s = s.getSubAbility()) {
            if (s.getApi() == ApiType.Counter) return true;
        }
        return false;
    }
}

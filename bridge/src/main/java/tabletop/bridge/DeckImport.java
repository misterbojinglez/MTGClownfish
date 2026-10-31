package tabletop.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.card.CardRules;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckImportController;
import forge.deck.DeckRecognizer.Token;
import forge.deck.DeckRecognizer.TokenType;
import forge.deck.DeckSection;
import forge.game.GameType;
import forge.gui.interfaces.ICheckBox;
import forge.gui.interfaces.IComboBox;
import forge.item.PaperCard;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pasted deck lists (Moxfield, MTGA, MTGO, plain "4 Forest" lines) → Forge decks, through Forge's own
 * import recognizer, which understands set codes, collector numbers, foil markers and section headers.
 */
final class DeckImport {
    static final class Result {
        Deck deck;
        final List<String> unknown = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
        /** legendary cards in the main deck that could lead it, for a list that doesn't say who its commander is */
        final Set<String> candidates = new LinkedHashSet<>();
        /** why Forge considers the deck illegal for the format, if it does (the game can still be played) */
        String problem;
    }

    private DeckImport() { }

    /**
     * @param commanders optional commander names chosen by the player; they're moved out of the main deck
     */
    static Result parse(final String text, final boolean commander, final List<String> commanders) {
        final Result r = new Result();
        final DeckImportController ctl = new DeckImportController(stub(ICheckBox.class), stub(IComboBox.class), stub(IComboBox.class), false);
        // no format constraint for constructed: any card Forge knows is fine against the AI
        ctl.setGameFormat(commander ? GameType.Commander : null);
        ctl.setAllowedSections(commander ? List.of(DeckSection.Main, DeckSection.Sideboard, DeckSection.Commander)
                : List.of(DeckSection.Main, DeckSection.Sideboard));
        ctl.importBannedAndRestrictedCards(true);
        final List<Token> tokens = ctl.parseInput(normalise(text, commander));
        for (final Token t : tokens) {
            if (t.getType() == TokenType.UNKNOWN_CARD || t.getType() == TokenType.UNSUPPORTED_CARD
                    || t.getType() == TokenType.UNKNOWN_TEXT && t.getText().matches("^\\d+x?\\s+.*")) {
                r.unknown.add(t.getText());
            } else if (t.getType() == TokenType.WARNING_MESSAGE) {
                r.warnings.add(t.getText().replaceAll("<[^>]+>", ""));
            }
        }
        final Deck deck = ctl.accept();
        if (deck == null || deck.getMain().isEmpty() && !deck.has(DeckSection.Commander)) {
            return r;
        }
        if (deck.getName() == null || deck.getName().isBlank()) {
            deck.setName("Custom deck");
        }
        if (commander) {
            if (commanders != null && !commanders.isEmpty()) {
                final CardPool cmd = deck.getOrCreate(DeckSection.Commander);
                // the player's pick replaces whatever the list implied
                for (final Map.Entry<PaperCard, Integer> e : new ArrayList<>(cmd.toFlatList().stream().map(c -> Map.entry(c, 1)).toList())) {
                    deck.getMain().add(e.getKey(), e.getValue());
                }
                cmd.clear();
                for (final String name : commanders) {
                    final PaperCard pc = findIn(deck.getMain(), name);
                    if (pc != null) {
                        deck.getMain().remove(pc, 1);
                        cmd.add(pc, 1);
                    }
                }
            }
            for (final Map.Entry<PaperCard, Integer> e : deck.getMain()) {
                final CardRules rules = e.getKey().getRules();
                if (rules.canBeCommander()) {
                    r.candidates.add(e.getKey().getName());
                }
            }
        }
        r.deck = deck;
        r.problem = (commander ? GameType.Commander : GameType.Constructed).getDeckFormat().getDeckConformanceProblem(deck);
        return r;
    }

    static JsonObject describe(final Result r, final boolean commander) {
        final JsonObject o = new JsonObject();
        o.addProperty("ok", r.deck != null);
        // a commander list that doesn't say who leads it: the player picks from the candidates
        o.addProperty("needsCommander", commander && r.deck != null
                && (!r.deck.has(DeckSection.Commander) || r.deck.get(DeckSection.Commander).isEmpty()));
        if (r.deck != null) {
            o.addProperty("name", r.deck.getName());
            o.addProperty("count", r.deck.getMain().countAll());
            final JsonArray cmd = new JsonArray();
            if (r.deck.has(DeckSection.Commander)) {
                for (final Map.Entry<PaperCard, Integer> e : r.deck.get(DeckSection.Commander)) {
                    cmd.add(e.getKey().getName());
                }
            }
            o.add("commanders", cmd);
            final JsonArray colors = new JsonArray();
            for (final String c : colorsOf(r.deck)) {
                colors.add(c);
            }
            o.add("colors", colors);
            // a card to show for the deck: the commander, else the most-played nonland card
            final PaperCard face = cardFace(r.deck);
            if (face != null) {
                final JsonObject f = new JsonObject();
                f.addProperty("name", face.getName());
                f.addProperty("set", face.getEdition());
                f.addProperty("cn", face.getCollectorNumber());
                o.add("face", f);
            }
        }
        final JsonArray unknown = new JsonArray();
        r.unknown.forEach(unknown::add);
        o.add("unknown", unknown);
        final JsonArray warnings = new JsonArray();
        r.warnings.forEach(warnings::add);
        o.add("warnings", warnings);
        final JsonArray candidates = new JsonArray();
        r.candidates.forEach(candidates::add);
        o.add("candidates", candidates);
        if (r.problem != null) {
            o.addProperty("problem", r.problem);
        }
        return o;
    }

    /**
     * Moxfield's plain-text export separates the commander(s) from the 99 with a blank line and no header.
     * For commander games, a short final (or first) blank-line group gets a "Commander" header so the
     * recognizer files it correctly. Lists that already name their sections are left alone.
     */
    static String normalise(final String text, final boolean commander) {
        final StringBuilder clean = new StringBuilder();
        for (final String line : text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1)) {
            // Moxfield annotations: #tags, ^colour tags^, and foil/etched markers
            clean.append(line.replaceAll("\\^[^^]*\\^", "").replaceAll("\\s#\\S+", "").replaceAll("\\s\\*[A-Z]\\*", "").stripTrailing()).append('\n');
        }
        final String t = clean.toString().strip();
        if (!commander || hasSectionHeader(t)) {
            return t;
        }
        final String[] groups = t.split("\\n\\s*\\n");
        if (groups.length < 2) {
            return t;
        }
        final String first = groups[0].strip();
        final String last = groups[groups.length - 1].strip();
        final StringBuilder sb = new StringBuilder();
        if (isCommanderGroup(last)) {
            sb.append("Commander\n").append(last).append("\n\nDeck\n");
            for (int i = 0; i < groups.length - 1; i++) {
                sb.append(groups[i].strip()).append('\n');
            }
            return sb.toString();
        }
        if (isCommanderGroup(first)) {
            sb.append("Commander\n").append(first).append("\n\nDeck\n");
            for (int i = 1; i < groups.length; i++) {
                sb.append(groups[i].strip()).append('\n');
            }
            return sb.toString();
        }
        return t;
    }

    private static boolean hasSectionHeader(final String t) {
        for (final String line : t.split("\n")) {
            final String s = line.trim().replaceAll("^[/#*]+\\s*", "").replaceAll("[:\\s]+$", "").toLowerCase();
            if (s.matches("commanders?|deck|main( ?deck| ?board)?|sideboard|companion|maybeboard|considering")) {
                return true;
            }
        }
        return false;
    }

    /** One or two single copies, e.g. "1 Atraxa, Praetors' Voice (C16) 28". */
    private static boolean isCommanderGroup(final String group) {
        final String[] lines = group.split("\n");
        if (lines.length > 2) {
            return false;
        }
        for (final String l : lines) {
            if (!l.trim().matches("^1x?\\s+\\S.*")) {
                return false;
            }
        }
        return true;
    }

    private static PaperCard findIn(final CardPool pool, final String name) {
        for (final Map.Entry<PaperCard, Integer> e : pool) {
            if (e.getKey().getName().equalsIgnoreCase(name)) {
                return e.getKey();
            }
        }
        return null;
    }

    static List<String> colorsOf(final Deck deck) {
        final List<String> out = new ArrayList<>();
        final String wubrg = "WUBRG";
        int mask = 0;
        final boolean cmd = deck.has(DeckSection.Commander) && !deck.get(DeckSection.Commander).isEmpty();
        for (final Map.Entry<PaperCard, Integer> e : cmd ? deck.get(DeckSection.Commander) : deck.getMain()) {
            mask |= e.getKey().getRules().getColorIdentity().getColor();
        }
        for (int i = 0; i < 5; i++) {
            if ((mask & (1 << i)) != 0) {
                out.add(String.valueOf(wubrg.charAt(i)));
            }
        }
        return out;
    }

    static PaperCard cardFace(final Deck deck) {
        if (deck.has(DeckSection.Commander) && !deck.get(DeckSection.Commander).isEmpty()) {
            return deck.get(DeckSection.Commander).get(0);
        }
        PaperCard best = null;
        int most = 0;
        for (final Map.Entry<PaperCard, Integer> e : deck.getMain()) {
            if (e.getKey().getRules().getType().isLand()) {
                continue;
            }
            if (e.getValue() > most) {
                most = e.getValue();
                best = e.getKey();
            }
        }
        return best;
    }

    /** A precon for the deck picker: name, commanders, colours and a card to show. */
    static JsonObject summary(final Deck deck) {
        final JsonObject o = new JsonObject();
        o.addProperty("name", deck.getName());
        final JsonArray cmds = new JsonArray();
        if (deck.has(DeckSection.Commander)) {
            for (final Map.Entry<PaperCard, Integer> e : deck.get(DeckSection.Commander)) {
                cmds.add(e.getKey().getName());
            }
        }
        o.add("commanders", cmds);
        final JsonArray colors = new JsonArray();
        colorsOf(deck).forEach(colors::add);
        o.add("colors", colors);
        final PaperCard face = cardFace(deck);
        if (face != null) {
            final JsonObject f = new JsonObject();
            f.addProperty("name", face.getName());
            f.addProperty("set", face.getEdition());
            f.addProperty("cn", face.getCollectorNumber());
            o.add("face", f);
        }
        return o;
    }

    /** The importer wants date-filter widgets; headless, they're inert stand-ins. */
    @SuppressWarnings("unchecked")
    private static <T> T stub(final Class<T> type) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            final Class<?> rt = method.getReturnType();
            if (rt == boolean.class) {
                return false;
            }
            if (rt == int.class) {
                return 0;
            }
            if (method.getName().equals("hashCode")) {
                return System.identityHashCode(proxy);
            }
            if (method.getName().equals("equals")) {
                return proxy == args[0];
            }
            return null;
        });
    }
}

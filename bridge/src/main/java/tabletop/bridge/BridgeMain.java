package tabletop.bridge;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.deck.Deck;
import forge.deck.DeckProxy;
import forge.deck.DeckgenUtil;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.card.CardView;
import forge.game.event.GameEvent;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.game.spellability.StackItemView;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.YieldController;
import forge.gamemodes.quest.QuestController;
import forge.gui.FThreads;
import forge.gui.GuiBase;
import forge.interfaces.IGameController;
import forge.localinstance.properties.ForgePreferences;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.trackable.TrackableTypes;
import forge.util.ITriggerEvent;

import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;

/**
 * Runs Forge headless behind a WebSocket. The client sends {@code start} to begin a game against AI
 * opponents and {@code action} messages for clicks; everything else flows through {@link SocketGuiGame}.
 */
public final class BridgeMain {
    private static Session session;
    private static SocketGuiGame gui;
    private static HostedMatch match;

    private BridgeMain() { }

    public static void main(final String[] args) throws Exception {
        final int port = Integer.parseInt(System.getProperty("bridge.port", "7777"));
        final String assets = System.getProperty("forge.assets", new File("../engine/forge/forge-gui").getCanonicalPath());

        GuiBase.setInterface(new HeadlessGui(assets));
        System.out.println("[bridge] loading Forge card database from " + assets + " ...");
        final long t0 = System.currentTimeMillis();
        FModel.initialize(null, null);
        System.out.println("[bridge] Forge ready in " + (System.currentTimeMillis() - t0) + " ms");
        // the client highlights playable cards and the auto-tap plan, Arena-style
        final var prefs = FModel.getPreferences();
        prefs.setPref(ForgePreferences.FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, true);
        prefs.setPref(ForgePreferences.FPref.UI_SHOW_AUTOTAP_PREVIEW, true);
        // Arena-style flow: pass priority automatically whenever there's nothing you could do,
        // and don't add Forge's artificial pauses (the client animates every action anyway)
        prefs.setPref(ForgePreferences.FPref.YIELD_AUTO_PASS_NO_ACTIONS, true);
        prefs.setPref(ForgePreferences.FPref.YIELD_SKIP_PHASE_DELAY, true);
        prefs.setPref(ForgePreferences.FPref.YIELD_SKIP_RESOLVE_DELAY, true);
        // Forge's "select from card displays" mode assumes its desktop zone windows (scry rearranging,
        // revealed hands); the dialog-based paths are the ones this client renders
        prefs.setPref(ForgePreferences.FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);

        session = new Session(port, BridgeMain::onClientMessage);
        session.start();
    }

    private static void onClientMessage(final JsonObject msg) {
        final String type = msg.has("type") ? msg.get("type").getAsString() : "";
        switch (type) {
            case "start" -> new Thread(() -> startGame(msg), "bridge-start").start();
            // leaving for the main menu: stop the game so the AIs don't play on in the background
            case "endGame" -> new Thread(() -> {
                if (match != null && match.getGame() != null && !match.getGame().isGameOver()) {
                    session.cancelPending();
                    match.endCurrentGame();
                }
            }, "bridge-end").start();
            case "validateDeck" -> new Thread(() -> validateDeck(msg), "bridge-deck").start();
            case "listPrecons" -> new Thread(() -> listPrecons(msg), "bridge-precons").start();
            // test tooling only: set up a board from Forge's game-state text (-Dbridge.dev=true)
            case "devState" -> {
                if (Boolean.getBoolean("bridge.dev") && match != null && match.getGame() != null) {
                    final forge.game.GameState gs = new forge.game.GameState();
                    gs.parse(java.util.Arrays.asList(msg.get("text").getAsString().split("\\r?\\n")));
                    gs.applyToGame(match.getGame());
                    // setting up a board fires no game events; push the new state once it's applied
                    new Thread(() -> {
                        try { Thread.sleep(1200); } catch (final InterruptedException ignored) { }
                        for (final forge.game.player.Player pl : match.getGame().getPlayers()) {
                            System.out.println("[dev] " + pl.getName() + " battlefield=" + pl.getCardsIn(forge.game.zone.ZoneType.Battlefield) + " hand=" + pl.getCardsIn(forge.game.zone.ZoneType.Hand));
                        }
                        gui.refreshField();
                        // the waiting prompt was wiped by the setup: show it again
                        for (final forge.game.player.Player pl : match.getGame().getPlayers()) {
                            if (pl.getController() instanceof forge.player.PlayerControllerHuman pch
                                    && pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputBase inp) {
                                FThreads.invokeInEdtLater(inp::showMessageInitial);
                            }
                        }
                    }, "bridge-dev").start();
                }
            }
            case "action" -> FThreads.invokeInEdtLater(() -> handleAction(msg));
            case "ping" -> {
                final JsonObject pong = new JsonObject();
                pong.addProperty("type", "pong");
                session.send(pong);
            }
            default -> System.err.println("[bridge] unknown message type: " + type);
        }
    }

    private static void startGame(final JsonObject msg) {
        final boolean commander = msg.has("format") && "commander".equalsIgnoreCase(msg.get("format").getAsString());
        final int playerCount = msg.has("players") ? Math.max(2, Math.min(4, msg.get("players").getAsInt())) : (commander ? 4 : 2);
        final GameType gameType = commander ? GameType.Commander : GameType.Constructed;

        if (match != null && match.getGame() != null && !match.getGame().isGameOver()) {
            session.cancelPending();
            match.endCurrentGame();
        }

        final List<RegisteredPlayer> players = new ArrayList<>();
        final JsonArray deckNames = new JsonArray();
        RegisteredPlayer human = null;
        final JsonArray seatDecks = msg.has("decks") && msg.get("decks").isJsonArray() ? msg.getAsJsonArray("decks") : new JsonArray();
        for (int i = 0; i < playerCount; i++) {
            Deck deck = null;
            final JsonObject spec = i < seatDecks.size() && seatDecks.get(i).isJsonObject() ? seatDecks.get(i).getAsJsonObject() : null;
            if (spec != null && spec.has("precon")) {
                deck = precon(spec.get("precon").getAsString(), commander);
            } else if (spec != null) {
                deck = pastedDeck(spec, commander, i);
            } else if (i == 0 && msg.has("deck")) {
                deck = deckFromList(msg.get("deck").getAsString());
            }
            if (deck == null) {
                deck = commander ? DeckgenUtil.getRandomCommanderPreconDeck() : DeckgenUtil.getRandomPreconDeck();
            }
            final RegisteredPlayer rp = commander ? RegisteredPlayer.forCommander(deck) : new RegisteredPlayer(deck);
            if (i == 0) {
                rp.setPlayer(new BridgeHumanPlayer("You"));
                human = rp;
            } else {
                rp.setPlayer(GamePlayerUtil.createAiPlayer(seatName(msg, i), i));
            }
            deckNames.add(deck.getName());
            players.add(rp);
        }

        final JsonObject starting = new JsonObject();
        starting.addProperty("type", "starting");
        starting.addProperty("format", gameType.name());
        starting.add("decks", deckNames);
        session.send(starting);

        gui = new SocketGuiGame(session);
        match = GuiBase.getInterface().hostMatch();
        GameRecord.begin(gameType.name(), players.size());
        match.setStartGameHook(() -> match.getGame().subscribeToEvents(new Object() {
            @Subscribe
            public void receiveGameEvent(final GameEvent event) {
                gui.onGameEvent(event);
                GameRecord.onEvent(match.getGame(), event);
            }
        }));
        final GameRules rules = new GameRules(gameType);
        rules.setAppliedVariants(EnumSet.of(gameType));
        rules.setGamesPerMatch(1);
        match.startMatch(rules, EnumSet.of(gameType), players, human, gui);
    }

    /** The name the client gave seat i (opponents can be named), else "AI i". Names must be unique. */
    private static String seatName(final JsonObject msg, final int i) {
        final String fallback = "AI " + i;
        if (!msg.has("names") || !msg.get("names").isJsonArray()) return fallback;
        final JsonArray names = msg.getAsJsonArray("names");
        if (i >= names.size() || !names.get(i).isJsonPrimitive()) return fallback;
        final String name = names.get(i).getAsString().trim();
        if (name.isEmpty() || name.equalsIgnoreCase("You") || name.length() > 24) return fallback;
        for (int j = 0; j < names.size(); j++) {
            if (j != i && names.get(j).isJsonPrimitive() && names.get(j).getAsString().trim().equalsIgnoreCase(name)) return fallback;
        }
        return name;
    }

    private static List<DeckProxy> precons(final boolean commander) {
        final List<DeckProxy> out = new ArrayList<>();
        if (commander) DeckProxy.getAllCommanderPreconDecks().forEach(out::add);
        else out.addAll(constructedPrecons());
        return out;
    }

    /** A specific precon by name, or null (→ random) if it isn't found. */
    private static Deck precon(final String name, final boolean commander) {
        for (final DeckProxy p : precons(commander)) {
            if (p.getName().equalsIgnoreCase(name)) return p.getDeck();
        }
        notice("error", "Couldn't find the precon \"" + name + "\", using a random one");
        return null;
    }

    private static JsonArray preconCache;
    private static JsonArray preconCacheCommander;

    private static void listPrecons(final JsonObject msg) {
        final boolean commander = msg.has("format") && "commander".equalsIgnoreCase(msg.get("format").getAsString());
        JsonArray decks = commander ? preconCacheCommander : preconCache;
        if (decks == null) {
            decks = new JsonArray();
            for (final DeckProxy p : precons(commander)) {
                try {
                    decks.add(DeckImport.summary(p.getDeck()));
                } catch (final RuntimeException e) {
                    System.err.println("[bridge] precon " + p.getName() + ": " + e.getMessage());
                }
            }
            if (commander) preconCacheCommander = decks;
            else preconCache = decks;
        }
        final JsonObject out = new JsonObject();
        out.addProperty("type", "precons");
        out.addProperty("format", commander ? "commander" : "constructed");
        out.add("decks", decks);
        session.send(out);
    }

    /** {list, commanders?} from the client's deck picker; null (→ a precon) if nothing usable came of it. */
    private static Deck pastedDeck(final JsonObject d, final boolean commander, final int seat) {
        final List<String> chosen = new ArrayList<>();
        if (d.has("commanders") && d.get("commanders").isJsonArray()) {
            d.getAsJsonArray("commanders").forEach(e -> chosen.add(e.getAsString()));
        }
        final DeckImport.Result r = DeckImport.parse(d.has("list") ? d.get("list").getAsString() : "", commander, chosen);
        if (r.deck == null) {
            notice("error", "Seat " + (seat + 1) + ": couldn't read that deck list, using a precon instead");
            return null;
        }
        if (d.has("name") && !d.get("name").getAsString().isBlank()) {
            r.deck.setName(d.get("name").getAsString());
        }
        if (!r.unknown.isEmpty()) {
            notice("message", r.deck.getName() + ": skipped " + r.unknown.size() + " unknown card(s)");
        }
        return r.deck;
    }

    private static void validateDeck(final JsonObject msg) {
        final boolean commander = msg.has("format") && "commander".equalsIgnoreCase(msg.get("format").getAsString());
        final List<String> chosen = new ArrayList<>();
        if (msg.has("commanders") && msg.get("commanders").isJsonArray()) {
            msg.getAsJsonArray("commanders").forEach(e -> chosen.add(e.getAsString()));
        }
        JsonObject out;
        try {
            out = DeckImport.describe(DeckImport.parse(msg.get("list").getAsString(), commander, chosen), commander);
        } catch (final RuntimeException e) {
            e.printStackTrace();
            out = new JsonObject();
            out.addProperty("ok", false);
            out.addProperty("problem", "Couldn't read the list: " + e.getMessage());
        }
        out.addProperty("type", "deckInfo");
        out.add("id", msg.get("id"));
        session.send(out);
    }

    private static void notice(final String kind, final String text) {
        final JsonObject n = new JsonObject();
        n.addProperty("type", "notice");
        n.addProperty("kind", kind);
        n.addProperty("text", text);
        session.send(n);
    }

    /** A plain "4 Forest" per line deck list (an optional "Commander:" line names the commander). */
    private static Deck deckFromList(final String list) {
        final Deck deck = new Deck("Custom");
        for (final String raw : list.split("\\r?\\n")) {
            final String line = raw.trim();
            if (line.isEmpty()) { continue; }
            if (line.toLowerCase().startsWith("commander:")) {
                deck.getOrCreate(forge.deck.DeckSection.Commander).add(line.substring(10).trim(), 1);
                continue;
            }
            final java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d+)x?\\s+(.+)$").matcher(line);
            if (m.matches()) {
                deck.getMain().add(m.group(2), Integer.parseInt(m.group(1)));
            } else {
                deck.getMain().add(line, 1);
            }
        }
        return deck;
    }

    /** A click from the client. Button 3 means right-click, which Forge reads as "undo this declaration". */
    private record Click(int button) implements ITriggerEvent {
        @Override public int getButton() { return button; }
        @Override public int getX() { return 0; }
        @Override public int getY() { return 0; }
    }

    private static void handleAction(final JsonObject msg) {
        if (gui == null || gui.getGameView() == null) {
            return;
        }
        final IGameController controller = gui.getGameController();
        if (controller == null) {
            return;
        }
        final var tracker = gui.getGameView().getTracker();
        final String action = msg.get("action").getAsString();
        final Integer id = msg.has("id") && !msg.get("id").isJsonNull() ? msg.get("id").getAsInt() : null;
        final Click click = new Click(msg.has("button") ? msg.get("button").getAsInt() : 1);

        // prompt answers are dropped when Forge has moved on from the prompt the player was answering
        if (msg.has("input") && GUARDED_ACTIONS.contains(action)) {
            final int meant = msg.get("input").getAsInt();
            final int now = gui.currentInputId();
            if (meant != now) {
                System.out.println("[bridge] dropped stale " + action + (id != null ? " " + id : "") + " (meant for prompt " + meant + ", now " + now + ")");
                // the player clicked while the table was still catching up; their own clicks get a word, auto-pay's don't
                if (!msg.has("auto")) {
                    gui.staleClick();
                }
                return;
            }
        }
        switch (action) {
            case "ok" -> {
                // the client's automatic payment never spends a source that has to be sacrificed: the player
                // decides (taps their own mana, or presses Auto, which comes without the flag)
                if (msg.has("auto") && msg.get("auto").getAsBoolean()) {
                    final List<String> sacrificed = gui.autoPaySacrifices();
                    if (!sacrificed.isEmpty()) {
                        gui.tell("Auto-pay would sacrifice " + String.join(" and ", sacrificed) + ". Tap your mana, or press Auto to use it.");
                        return;
                    }
                }
                controller.selectButtonOk();
            }
            case "cancel" -> controller.selectButtonCancel();
            case "card" -> {
                final CardView card = tracker.getObj(TrackableTypes.CardViewType, id);
                if (card != null) { controller.selectCard(card, null, click); }
            }
            case "player" -> {
                final PlayerView player = tracker.getObj(TrackableTypes.PlayerViewType, id);
                if (player != null) { controller.selectPlayer(player, click); }
            }
            case "stack" -> {
                final StackItemView item = tracker.getObj(TrackableTypes.StackItemViewType, id);
                if (item != null) { controller.selectStackItem(item); }
            }
            case "mana" -> controller.useMana((byte) msg.get("color").getAsInt());
            case "alphaStrike" -> controller.alphaStrike();
            case "undo" -> controller.undoLastAction();
            case "concede" -> controller.concede();
            // sets the end-of-turn yield and passes the priority currently held, like Forge's End Turn shortcut
            // the client animates behind the engine: a pass meant for a turn that has already ended is dropped,
            // or it would skip the player's next turn
            case "passUntilEndOfTurn" -> {
                final int seenTurn = msg.has("turn") ? msg.get("turn").getAsInt() : -1;
                if (seenTurn < 0 || seenTurn == gui.getGameView().getTurn()) {
                    YieldController.endTurn(controller, gui.getCurrentPlayer());
                }
            }
            case "reorderHand" -> {
                final CardView card = tracker.getObj(TrackableTypes.CardViewType, id);
                if (card != null) { controller.reorderHand(card, msg.get("index").getAsInt()); }
            }
            default -> System.err.println("[bridge] unknown action: " + action);
        }
    }

    /** Actions that answer the prompt on screen; the rest (pass turn, concede, undo, hand order) stand alone. */
    private static final java.util.Set<String> GUARDED_ACTIONS = java.util.Set.of("ok", "cancel", "card", "player", "stack", "mana", "alphaStrike");

    private static List<DeckProxy> constructedPrecons() {
        return DeckProxy.getAllPreconstructedDecks(QuestController.getPrecons());
    }
}

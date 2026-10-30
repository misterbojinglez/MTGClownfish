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
        for (int i = 0; i < playerCount; i++) {
            final Deck deck = i == 0 && msg.has("deck") ? deckFromList(msg.get("deck").getAsString())
                    : commander ? DeckgenUtil.getRandomCommanderPreconDeck() : DeckgenUtil.getRandomPreconDeck();
            final RegisteredPlayer rp = commander ? RegisteredPlayer.forCommander(deck) : new RegisteredPlayer(deck);
            if (i == 0) {
                rp.setPlayer(GamePlayerUtil.getGuiPlayer("You", 0, 0, false));
                human = rp;
            } else {
                rp.setPlayer(GamePlayerUtil.createAiPlayer("AI " + i, i));
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
        match.setStartGameHook(() -> match.getGame().subscribeToEvents(new Object() {
            @Subscribe
            public void receiveGameEvent(final GameEvent event) {
                gui.onGameEvent(event);
            }
        }));
        final GameRules rules = new GameRules(gameType);
        rules.setAppliedVariants(EnumSet.of(gameType));
        rules.setGamesPerMatch(1);
        match.startMatch(rules, EnumSet.of(gameType), players, human, gui);
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

        switch (action) {
            case "ok" -> controller.selectButtonOk();
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

    @SuppressWarnings("unused")
    private static List<DeckProxy> constructedPrecons() {
        return DeckProxy.getAllPreconstructedDecks(QuestController.getPrecons());
    }
}

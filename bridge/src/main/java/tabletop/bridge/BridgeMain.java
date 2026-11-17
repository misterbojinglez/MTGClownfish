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
import forge.game.zone.ZoneType;
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
    private static HostedMatch match;

    private BridgeMain() { }

    public static void main(final String[] args) throws Exception {
        final int port = Integer.parseInt(System.getProperty("bridge.port", "7777"));
        final String assets = System.getProperty("forge.assets", new File("../engine/forge/forge-gui").getCanonicalPath());
        // started by the desktop app: it holds our standard input open, so its end (quit, or a crash) closes it.
        // Exit then too, or an orphaned bridge would keep the game's ports and the next launch couldn't start
        if (Boolean.getBoolean("bridge.exitWithParent")) {
            final Thread watch = new Thread(() -> {
                try {
                    while (System.in.read() >= 0) { /* nothing is sent; just wait for the end */ }
                } catch (final java.io.IOException ignored) {
                    // closed
                }
                System.out.println("[bridge] the app has gone; exiting");
                System.exit(0);
            }, "parent-watch");
            watch.setDaemon(true);
            watch.start();
        }

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

        Hub.onMessage(BridgeMain::onClientMessage);
        session = new Session(port);
        session.start();
        // the shareable package: the bridge also serves the built client, so testers need only Java
        final String clientDir = System.getProperty("client.dir");
        if (clientDir != null) {
            ClientServer.start(new File(clientDir).toPath(), Integer.parseInt(System.getProperty("client.port", "7780")));
        }
    }

    /** who a handler's notices go to (the player whose message it's handling), else everyone in the game */
    private static final ThreadLocal<Client> REPLY_TO = new ThreadLocal<>();

    /** Run a handler off the socket thread, its notices going to the player who asked. */
    private static void spawn(final Client c, final String name, final Runnable r) {
        new Thread(() -> {
            REPLY_TO.set(c);
            try {
                r.run();
            } catch (final RuntimeException e) {
                e.printStackTrace();
            }
        }, name).start();
    }

    /** The people in the current game (their views get its events), and who started it. */
    private static volatile List<Client> inGame = List.of();
    private static volatile Client gameHost;

    private static void onClientMessage(final Client c, final JsonObject msg) {
        final String type = msg.has("type") ? msg.get("type").getAsString() : "";
        // a friend's browser (through the relay) may only play their own seat and use their lobby seat;
        // starting games, test tooling and gameplans (which spend the host's API key) are for this computer
        final boolean local = !c.remote();
        switch (type) {
            case "hello", "_disconnected" -> Lobby.onPresence(c, type);
            case "start" -> { if (local) spawn(c, "bridge-start", () -> startGame(c, msg)); }
            // leaving for the main menu: the host's leaving stops the game so the AIs don't play on in the
            // background; anyone else leaving concedes their seat
            case "endGame" -> spawn(c, "bridge-end", () -> leaveGame(c));
            case "validateDeck" -> spawn(c, "bridge-deck", () -> validateDeck(c, msg));
            case "listPrecons" -> spawn(c, "bridge-precons", () -> listPrecons(c, msg));
            case "compileGameplan" -> { if (local) spawn(c, "bridge-gameplan", () -> compileGameplan(c, msg)); }
            case "hostLobby", "lobbySeat", "lobbyConfig", "lobbyStart", "leaveLobby" -> spawn(c, "bridge-lobby", () -> Lobby.onMessage(c, type, msg));
            // test tooling only: set up a board from Forge's game-state text (-Dbridge.dev=true)
            case "devState" -> {
                if (local && Boolean.getBoolean("bridge.dev") && match != null && match.getGame() != null) {
                    final forge.game.GameState gs = new forge.game.GameState();
                    gs.parse(java.util.Arrays.asList(msg.get("text").getAsString().split("\\r?\\n")));
                    gs.applyToGame(match.getGame());
                    // setting up a board fires no game events; push the new state once it's applied
                    new Thread(() -> {
                        try { Thread.sleep(1200); } catch (final InterruptedException ignored) { }
                        for (final forge.game.player.Player pl : match.getGame().getPlayers()) {
                            System.out.println("[dev] " + pl.getName() + " battlefield=" + pl.getCardsIn(forge.game.zone.ZoneType.Battlefield) + " hand=" + pl.getCardsIn(forge.game.zone.ZoneType.Hand));
                        }
                        for (final Client p : inGame) if (p.gui != null) p.gui.refreshField();
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
            case "action" -> FThreads.invokeInEdtLater(() -> handleAction(c, msg));
            case "ping" -> {
                final JsonObject pong = new JsonObject();
                pong.addProperty("type", "pong");
                c.send(pong);
            }
            default -> System.err.println("[bridge] unknown message type: " + type);
        }
    }

    /** One seat of a game being started: a person (their client) or an AI, a name, and a deck spec. */
    record SeatSetup(Client human, String name, JsonObject spec) { }

    /** {type: start} from this computer's browser: you in seat 0 against AI opponents. */
    private static void startGame(final Client c, final JsonObject msg) {
        final boolean commander = msg.has("format") && "commander".equalsIgnoreCase(msg.get("format").getAsString());
        final int playerCount = msg.has("players") ? Math.max(2, Math.min(4, msg.get("players").getAsInt())) : (commander ? 4 : 2);
        final JsonArray seatDecks = msg.has("decks") && msg.get("decks").isJsonArray() ? msg.getAsJsonArray("decks") : new JsonArray();
        final List<SeatSetup> seats = new ArrayList<>();
        for (int i = 0; i < playerCount; i++) {
            JsonObject spec = i < seatDecks.size() && seatDecks.get(i).isJsonObject() ? seatDecks.get(i).getAsJsonObject() : null;
            if (spec == null && i == 0 && msg.has("deck")) {
                spec = new JsonObject();
                spec.addProperty("plainList", msg.get("deck").getAsString());
            }
            seats.add(new SeatSetup(i == 0 ? c : null, i == 0 ? "You" : seatName(msg, i), spec));
        }
        launch(seats, commander, msg.has("apiKey") && msg.get("apiKey").isJsonPrimitive() ? msg.get("apiKey").getAsString() : null, c);
    }

    /** Start a game: people in their seats (each with their own view), AI opponents in the rest. */
    static void launch(final List<SeatSetup> seats, final boolean commander, final String apiKey, final Client host) {
        final GameType gameType = commander ? GameType.Commander : GameType.Constructed;
        stopGame();
        BridgeHumanPlayer.resetAll();
        Serializer.resetLive();

        final List<RegisteredPlayer> players = new ArrayList<>();
        final java.util.Map<RegisteredPlayer, forge.gui.interfaces.IGuiGame> guis = new java.util.LinkedHashMap<>();
        final List<Client> people = new ArrayList<>();
        final JsonArray deckNames = new JsonArray();
        for (int i = 0; i < seats.size(); i++) {
            final SeatSetup seat = seats.get(i);
            final JsonObject spec = seat.spec();
            Deck deck = null;
            if (spec != null && spec.has("precon")) {
                deck = precon(spec.get("precon").getAsString(), commander);
            } else if (spec != null && spec.has("plainList")) {
                deck = deckFromList(spec.get("plainList").getAsString());
            } else if (spec != null && spec.has("list")) {
                deck = pastedDeck(spec, commander, i);
            }
            if (deck == null) {
                deck = commander ? DeckgenUtil.getRandomCommanderPreconDeck() : DeckgenUtil.getRandomPreconDeck();
            }
            final RegisteredPlayer rp = commander ? RegisteredPlayer.forCommander(deck) : new RegisteredPlayer(deck);
            if (seat.human() != null) {
                rp.setPlayer(new BridgeHumanPlayer(seat.name()));
                final SocketGuiGame view = new SocketGuiGame(seat.human());
                seat.human().gui = view;
                guis.put(rp, view);
                people.add(seat.human());
            } else {
                // an opponent with a gameplan plays to it (made now if it isn't cached from the setup screen)
                final Gameplan.Plan plan = spec != null ? seatPlan(spec, deck, seat.name(), apiKey) : null;
                rp.setPlayer(plan != null ? PlannedAi.create(seat.name(), i, plan) : GamePlayerUtil.createAiPlayer(seat.name(), i));
            }
            deckNames.add(deck.getName());
            players.add(rp);
        }

        final JsonObject starting = new JsonObject();
        starting.addProperty("type", "starting");
        starting.addProperty("format", gameType.name());
        starting.add("decks", deckNames);
        for (final Client p : people) p.send(starting);

        inGame = List.copyOf(people);
        gameHost = host;
        match = GuiBase.getInterface().hostMatch();
        GameRecord.begin(gameType.name(), players.size());
        final List<SocketGuiGame> views = people.stream().map(p -> p.gui).toList();
        match.setStartGameHook(() -> match.getGame().subscribeToEvents(new Object() {
            @Subscribe
            public void receiveGameEvent(final GameEvent event) {
                for (final SocketGuiGame v : views) v.onGameEvent(event);
                GameRecord.onEvent(match.getGame(), event);
                // an online table goes back to its lobby (players leave the game-over screen when they like)
                if (event instanceof forge.game.event.GameEventGameOutcome) Lobby.gameOver();
            }
        }));
        final GameRules rules = new GameRules(gameType);
        rules.setAppliedVariants(EnumSet.of(gameType));
        rules.setGamesPerMatch(1);
        match.startMatch(rules, EnumSet.of(gameType), players, guis, null);
    }

    /** End the current game, if one is running (everyone's open questions are dropped). */
    static void stopGame() {
        if (match != null && match.getGame() != null && !match.getGame().isGameOver()) {
            for (final Client p : inGame) p.cancelPending();
            match.endCurrentGame();
            // a player in the middle of an input (paying mana, declaring attackers) holds the game thread on it:
            // let it go, or the old game's thread waits forever
            for (final Client p : inGame) {
                final SocketGuiGame v = p.gui;
                if (v != null && v.getGameController() instanceof forge.player.PlayerControllerHuman pch) {
                    pch.getInputQueue().onGameOver(true);
                }
            }
            // everyone else at the table hears why their game stopped
            final JsonObject n = new JsonObject();
            n.addProperty("type", "notice");
            n.addProperty("kind", "gameAbandoned");
            n.addProperty("text", "The host ended the game.");
            for (final Client p : inGame) if (p != gameHost) p.send(n);
        }
        Lobby.gameOver();
        for (final Client p : inGame) p.gui = null;
        inGame = List.of();
    }

    /** A player heads for the main menu: the one who started the game stops it; anyone else concedes. */
    private static void leaveGame(final Client c) {
        if (!inGame.contains(c)) return;
        if (c == gameHost || inGame.size() == 1) {
            stopGame();
            return;
        }
        final SocketGuiGame view = c.gui;
        if (view != null && view.getGameController() != null && match != null && match.getGame() != null && !match.getGame().isGameOver()) {
            FThreads.invokeInEdtLater(() -> view.getGameController().concede());
        }
        c.cancelPending();
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

    private static void listPrecons(final Client c, final JsonObject msg) {
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
        c.send(out);
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

    private static void validateDeck(final Client c, final JsonObject msg) {
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
        c.send(out);
    }

    /** The seat's gameplan as AI settings, or null (no gameplan, or it couldn't be made: the seat plays as usual). */
    private static Gameplan.Plan seatPlan(final JsonObject spec, final Deck deck, final String name, final String key) {
        // test tooling only: a ready-made plan, no Claude request
        if (Boolean.getBoolean("bridge.dev") && spec.has("devPlan")) {
            try {
                return Gameplan.parse(spec.get("devPlan").toString());
            } catch (final java.io.IOException e) {
                System.err.println("[gameplan] bad devPlan: " + e.getMessage());
                return null;
            }
        }
        final String text = spec.has("gameplan") && spec.get("gameplan").isJsonPrimitive() ? spec.get("gameplan").getAsString() : "";
        if (text.isBlank()) return null;
        try {
            if (Gameplan.cached(deck, text).isEmpty()) notice("message", "Preparing " + name + "'s gameplan…");
            final Gameplan.Plan plan = Gameplan.make(deck, text, key);
            System.out.println("[gameplan] " + name + " plays " + deck.getName() + " to plan: " + plan.summary());
            return plan;
        } catch (final Gameplan.GameplanException e) {
            notice("error", name + " plays without the gameplan: " + e.getMessage());
            return null;
        }
    }

    /**
     * The setup screen's "translate for the AI": the seat's deck (precon or pasted list) and gameplan become a
     * plan, which is cached and described back so the player can see how the AI read it.
     */
    private static void compileGameplan(final Client c, final JsonObject msg) {
        final JsonObject out = new JsonObject();
        out.addProperty("type", "gameplan");
        out.add("id", msg.get("id"));
        try {
            final boolean commander = msg.has("format") && "commander".equalsIgnoreCase(msg.get("format").getAsString());
            final JsonObject spec = msg.getAsJsonObject("spec");
            final Deck deck = spec.has("precon") ? precon(spec.get("precon").getAsString(), commander) : pastedDeck(spec, commander, 1);
            if (deck == null) throw new Gameplan.GameplanException("Couldn't load that deck.", false);
            final String key = msg.has("apiKey") && msg.get("apiKey").isJsonPrimitive() ? msg.get("apiKey").getAsString() : null;
            final Gameplan.Plan plan = Gameplan.make(deck, msg.get("gameplan").getAsString(), key);
            out.addProperty("ok", true);
            out.addProperty("summary", plan.summary());
            out.addProperty("stance", plan.stance());
            out.addProperty("tokensAreFodder", plan.tokensAreFodder());
            final JsonArray cards = new JsonArray();
            for (final Gameplan.CardHint h : plan.cards()) {
                final JsonObject hint = new JsonObject();
                hint.addProperty("name", h.name());
                hint.addProperty("castPriority", h.castPriority());
                hint.addProperty("value", h.value());
                hint.addProperty("sacrificeFodder", h.sacrificeFodder());
                hint.addProperty("discardFodder", h.discardFodder());
                hint.addProperty("castBeforeCombat", h.castBeforeCombat());
                hint.addProperty("protect", h.protect());
                hint.addProperty("engine", h.engine());
                cards.add(hint);
            }
            out.add("cards", cards);
        } catch (final Gameplan.GameplanException e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage());
            out.addProperty("noKey", e.noKey);
        } catch (final RuntimeException e) {
            e.printStackTrace();
            out.addProperty("ok", false);
            out.addProperty("error", "Couldn't make the plan: " + e.getMessage());
        }
        c.send(out);
    }

    /** A message for the player whose request is being handled, or for everyone in the game. */
    private static void notice(final String kind, final String text) {
        final JsonObject n = new JsonObject();
        n.addProperty("type", "notice");
        n.addProperty("kind", kind);
        n.addProperty("text", text);
        final Client to = REPLY_TO.get();
        if (to != null) to.send(n);
        else for (final Client p : inGame) p.send(n);
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

    private static void handleAction(final Client c, final JsonObject msg) {
        final SocketGuiGame gui = c.gui;
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

        // a friend's browser (through the relay) must say which prompt a click answers: unguarded clicks racing the
        // engine (a land tapped while a cancelled payment is being rolled back) can kill the game thread
        if (c.remote() && !msg.has("input") && GUARDED_ACTIONS.contains(action)) {
            return;
        }
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
                CardView card = tracker.getObj(TrackableTypes.CardViewType, id);
                // a prepared permanent: with priority, a click casts its waiting spell copy (which sits in exile,
                // out of sight); in combat or a selection the click stays with the creature. Asked of the game
                // itself: the tracked view can still describe the card as it was on the stack.
                if (id != null && click.getButton() == 1 && "InputPassPriority".equals(gui.currentInputSimpleName())) {
                    final forge.game.Game game = gui.getGameView().getGame();
                    final forge.game.card.Card real = game == null ? null : game.findById(id);
                    if (real != null && real.isInZone(ZoneType.Battlefield) && real.isPrepared() && real.getPreparedSpell() != null) {
                        card = real.getPreparedSpell().getView();
                    }
                }
                if (card != null) { controller.selectCard(card, null, click); }
            }
            case "player" -> {
                final PlayerView player = tracker.getObj(TrackableTypes.PlayerViewType, id);
                if (player != null) {
                    controller.selectPlayer(player, click);
                    recheckAutoPay(controller);
                }
            }
            case "stack" -> {
                final StackItemView item = tracker.getObj(TrackableTypes.StackItemViewType, id);
                if (item != null) { controller.selectStackItem(item); }
            }
            case "mana" -> controller.useMana((byte) msg.get("color").getAsInt());
            // "Use floating mana": what's in the pool goes toward the cost being paid, a unit at a time (colourless
            // first, keeping coloured mana for coloured symbols), until it's paid or nothing more fits. Forge only
            // spends floating mana by clicks on the pool, and Auto stays off for some costs (paying K'rrik's black
            // with life), which left floating mana with no way in
            case "floating" -> {
                if (controller instanceof forge.player.PlayerControllerHuman pch) {
                    final byte[] order = { forge.card.mana.ManaAtom.COLORLESS, forge.card.mana.ManaAtom.WHITE, forge.card.mana.ManaAtom.BLUE,
                            forge.card.mana.ManaAtom.BLACK, forge.card.mana.ManaAtom.RED, forge.card.mana.ManaAtom.GREEN };
                    for (int guard = 0; guard < 60; guard++) {
                        if (!(pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputPayMana)) break;
                        final int before = pch.getPlayer().getManaPool().totalMana();
                        for (final byte color : order) {
                            controller.useMana(color);
                            if (pch.getPlayer().getManaPool().totalMana() != before) break;
                        }
                        if (pch.getPlayer().getManaPool().totalMana() == before) break;
                    }
                }
            }
            case "alphaStrike" -> controller.alphaStrike();
            case "undo" -> controller.undoLastAction();
            case "concede" -> controller.concede();
            // sets the end-of-turn yield and passes the priority currently held, like Forge's End Turn shortcut
            // the client animates behind the engine: a pass meant for a turn that has already ended is dropped,
            // or it would skip the player's next turn
            case "passUntilEndOfTurn" -> {
                final int seenTurn = msg.has("turn") ? msg.get("turn").getAsInt() : -1;
                if (seenTurn < 0 || seenTurn == gui.getGameView().getTurn()) {
                    // nor one pressed before the table showed an opponent's newest spell or ability: Forge's
                    // "an opponent's spell interrupts the yield" has already happened by then, so the late pass
                    // would set the yield again and let that spell resolve without the player seeing it
                    final String unseen = msg.has("stack") ? unseenOpponentItem(gui, msg.getAsJsonArray("stack")) : null;
                    if (unseen != null) {
                        gui.tell(unseen + " just went on the stack, so Pass Turn waited for you. Pass again to let it resolve.");
                    } else {
                        YieldController.endTurn(controller, gui.getCurrentPlayer());
                    }
                }
            }
            case "reorderHand" -> {
                final CardView card = tracker.getObj(TrackableTypes.CardViewType, id);
                if (card != null) { controller.reorderHand(card, msg.get("index").getAsInt()); }
            }
            default -> System.err.println("[bridge] unknown action: " + action);
        }
    }

    /** The name of a spell or ability an opponent has on the stack that isn't among the stack items the player has seen, or null. */
    private static String unseenOpponentItem(final SocketGuiGame gui, final JsonArray seen) {
        final java.util.Set<Integer> shown = new java.util.HashSet<>();
        for (final com.google.gson.JsonElement e : seen) {
            if (e.isJsonPrimitive()) shown.add(e.getAsInt());
        }
        final var stack = gui.getGameView().getStack();
        if (stack == null) return null;
        final int me = gui.playerId();
        for (final forge.game.spellability.StackItemView si : stack) {
            final boolean mine = si.getActivatingPlayer() != null && si.getActivatingPlayer().getId() == me;
            if (!mine && !shown.contains(si.getId())) {
                return si.getSourceCard() != null ? si.getSourceCard().getName() : "Something";
            }
        }
        return null;
    }

    /** Actions that answer the prompt on screen; the rest (pass turn, concede, undo, hand order) stand alone. */
    /**
     * Paying a symbol with life (Phyrexian mana, K'rrik's {B}) shrinks the cost, but Forge keeps its Auto plan
     * from before: a cost that wasn't payable stayed "not payable", so Auto stayed off even once the mana on hand
     * covered what was left. Forget the plan and refresh the prompt so it's worked out again.
     */
    private static void recheckAutoPay(final IGameController controller) {
        if (!(controller instanceof forge.player.PlayerControllerHuman pch)) return;
        if (!(pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputPayMana ipm)) return;
        try {
            final java.lang.reflect.Method m = forge.gamemodes.match.input.InputPayMana.class.getDeclaredMethod("invalidateAutoPayManaSources");
            m.setAccessible(true);
            m.invoke(ipm);
            ipm.showMessage();
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.err.println("[bridge] couldn't recheck auto-pay: " + e);
        }
    }

    private static final java.util.Set<String> GUARDED_ACTIONS = java.util.Set.of("ok", "cancel", "card", "player", "stack", "mana", "floating", "alphaStrike");

    private static List<DeckProxy> constructedPrecons() {
        return DeckProxy.getAllPreconstructedDecks(QuestController.getPrecons());
    }
}

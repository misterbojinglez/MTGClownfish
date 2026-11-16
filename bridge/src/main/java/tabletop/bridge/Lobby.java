package tabletop.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/**
 * An online lobby: the host (the browser on this computer) opens it, the relay gives it a code, and friends
 * join from their own browsers. Each seat is the host, a friend, an AI, or open (an AI if nobody takes it by
 * the time the game starts). Everyone picks their own deck; the host picks the AI seats' decks and starts.
 *
 * One lobby per bridge. It stays open across games, so the table can play again; it closes when the host
 * leaves it.
 *
 * Messages (browser → bridge):
 * <pre>
 *   hostLobby   {format, players, name}                     host only: open a lobby
 *   lobbySeat   {deck, info, ready}                         your own seat's deck (a seat spec) and readiness
 *   lobbyConfig {format?, players?, seat?, kind?, deck?, info?, gameplan?}   host only: the table and its seats
 *   lobbyStart  {apiKey?}                                   host only: start the game
 *   leaveLobby  {}                                          a friend gives up their seat; the host closes the lobby
 * </pre>
 * and the bridge sends everyone {@code lobby} (the whole lobby, from their point of view) whenever it changes.
 */
final class Lobby {
    private Lobby() { }

    static final class Seat {
        /** "host", "human", "ai" or "open" */
        String kind;
        Client client;
        String name;
        /** the deck spec the game is started with (precon or pasted list), or null for a random precon */
        JsonObject deck;
        /** what to show for the deck: {label, commanders, colors, face} */
        JsonObject info;
        /** an AI seat's gameplan (host's choice) */
        String gameplan;
        boolean ready;

        Seat(final String kind) {
            this.kind = kind;
        }

        boolean person() {
            return client != null;
        }
    }

    private static final int MAX_LIST = 20000;
    private static final String[] AI_NAMES = { "Rook", "Kestrel", "Dorian", "Wren", "Sable", "Quill" };

    private static Client host;
    private static String format = "commander";
    private static final List<Seat> seats = new ArrayList<>();
    private static RelayLink link;
    private static String problem;
    private static boolean playing;

    static synchronized boolean open() {
        return host != null;
    }

    // ---- messages ------------------------------------------------------------------------------------

    static synchronized void onMessage(final Client c, final String type, final JsonObject msg) {
        switch (type) {
            case "hostLobby" -> hostLobby(c, msg);
            case "lobbySeat" -> setOwnSeat(c, msg);
            case "lobbyConfig" -> { if (c == host) configure(msg); }
            case "lobbyStart" -> { if (c == host) start(msg); }
            case "leaveLobby" -> leave(c);
            default -> { }
        }
    }

    /** A browser said hello, or went away. A friend coming in through the relay is given a seat. */
    static synchronized void onPresence(final Client c, final String type) {
        if (host == null) {
            // nobody's hosting: a friend who reached us through the relay hears so
            if (c.remote() && "hello".equals(type)) {
                final JsonObject m = new JsonObject();
                m.addProperty("type", "lobbyClosed");
                m.addProperty("reason", "That game isn't open any more.");
                c.send(m);
            }
            return;
        }
        if ("_disconnected".equals(type)) {
            broadcast();
            return;
        }
        if (!"hello".equals(type)) return;
        if (seatOf(c) != null) {
            broadcast(); // a returning player: everyone sees them back
            return;
        }
        if (!c.remote()) return;
        if (playing) {
            refuse(c, "That game has already started.");
            return;
        }
        final Seat free = seats.stream().filter(s -> "open".equals(s.kind)).findFirst().orElse(null);
        if (free == null) {
            refuse(c, "That table is full.");
            return;
        }
        free.kind = "human";
        free.client = c;
        free.name = uniqueName(c.name, free);
        free.deck = null;
        free.info = null;
        free.ready = false;
        System.out.println("[lobby] " + free.name + " joined");
        broadcast();
    }

    private static void refuse(final Client c, final String reason) {
        final JsonObject m = new JsonObject();
        m.addProperty("type", "lobbyClosed");
        m.addProperty("reason", reason);
        c.send(m);
        if (link != null && c.pipe() != null) link.kick(c.pipe());
        Hub.forget(c);
    }

    private static void hostLobby(final Client c, final JsonObject msg) {
        if (c.remote()) return;
        final String relay = RelayLink.relayUrl();
        if (relay.isEmpty()) {
            final JsonObject m = new JsonObject();
            m.addProperty("type", "lobbyClosed");
            m.addProperty("reason", "Online play isn't set up in this copy (no relay address).");
            c.send(m);
            return;
        }
        close("The host opened a new lobby.");
        // a game still running (an online one left behind, or a game against the AI) ends here
        BridgeMain.stopGame();
        host = c;
        format = str(msg, "format", "commander").equalsIgnoreCase("constructed") ? "constructed" : "commander";
        final int players = Math.max(2, Math.min(4, num(msg, "players", "commander".equals(format) ? 4 : 2)));
        final String name = Hub.cleanName(str(msg, "name", ""));
        if (!name.isEmpty()) c.name = name;
        seats.clear();
        final Seat mine = new Seat("host");
        mine.client = c;
        mine.name = c.name == null || c.name.isBlank() || c.name.equals("You") ? "Host" : c.name;
        seats.add(mine);
        for (int i = 1; i < players; i++) seats.add(openSeat(i));
        problem = null;
        playing = false;
        link = new RelayLink(relay, code -> broadcast(), reason -> {
            synchronized (Lobby.class) {
                problem = reason;
                broadcast();
            }
        });
        link.connect();
        broadcast();
    }

    private static Seat openSeat(final int i) {
        final Seat s = new Seat("open");
        s.name = AI_NAMES[(i - 1) % AI_NAMES.length];
        return s;
    }

    private static void setOwnSeat(final Client c, final JsonObject msg) {
        final Seat s = seatOf(c);
        if (s == null || playing) return;
        if (msg.has("deck")) {
            s.deck = cleanDeck(msg.get("deck"));
            s.info = cleanInfo(msg.get("info"));
        }
        if (msg.has("ready")) s.ready = msg.get("ready").getAsBoolean();
        if (msg.has("name")) {
            final String n = Hub.cleanName(msg.get("name").getAsString());
            if (!n.isEmpty()) s.name = uniqueName(n, s);
        }
        broadcast();
    }

    /** The host changes the table: format, number of seats, a seat open or AI (or a friend removed), an AI's deck. */
    private static void configure(final JsonObject msg) {
        if (playing) return;
        if (msg.has("format")) {
            format = str(msg, "format", format).equalsIgnoreCase("constructed") ? "constructed" : "commander";
            // decks are format-specific: start over
            for (final Seat s : seats) {
                s.deck = null;
                s.info = null;
                s.gameplan = null;
                s.ready = false;
            }
        }
        if (msg.has("players")) {
            final int n = Math.max(2, Math.min(4, num(msg, "players", seats.size())));
            while (seats.size() > n) {
                final Seat gone = seats.remove(seats.size() - 1);
                if (gone.client != null && gone != seats.get(0)) dismiss(gone.client, "The host made the table smaller.");
            }
            while (seats.size() < n) seats.add(openSeat(seats.size()));
        }
        if (msg.has("seat")) {
            final int i = num(msg, "seat", -1);
            if (i > 0 && i < seats.size()) {
                final Seat s = seats.get(i);
                final String kind = str(msg, "kind", s.kind);
                if (("ai".equals(kind) || "open".equals(kind)) && !kind.equals(s.kind)) {
                    if (s.client != null) dismiss(s.client, "The host gave your seat to an AI.");
                    s.client = null;
                    s.kind = kind;
                    s.name = AI_NAMES[(i - 1) % AI_NAMES.length];
                    s.deck = null;
                    s.info = null;
                    s.ready = false;
                }
                // an AI (or still-open) seat's deck and gameplan are the host's to pick
                if (!s.person()) {
                    if (msg.has("deck")) {
                        s.deck = cleanDeck(msg.get("deck"));
                        s.info = cleanInfo(msg.get("info"));
                    }
                    if (msg.has("gameplan")) {
                        final String g = msg.get("gameplan").isJsonPrimitive() ? msg.get("gameplan").getAsString().trim() : "";
                        s.gameplan = g.isEmpty() ? null : g.substring(0, Math.min(1500, g.length()));
                    }
                    if (msg.has("name")) {
                        final String n = Hub.cleanName(msg.get("name").getAsString());
                        if (!n.isEmpty()) s.name = uniqueName(n, s);
                    }
                }
            }
        }
        broadcast();
    }

    private static void start(final JsonObject msg) {
        if (playing) return;
        final List<BridgeMain.SeatSetup> setup = new ArrayList<>();
        for (final Seat s : seats) {
            JsonObject spec = s.deck == null ? null : s.deck.deepCopy();
            if (!s.person() && s.gameplan != null && spec != null) spec.addProperty("gameplan", s.gameplan);
            // a friend who dropped out before the start: their seat plays as an AI
            final Client who = s.person() && s.client.connected() ? s.client : null;
            setup.add(new BridgeMain.SeatSetup(who, s.name, spec));
        }
        final String key = msg.has("apiKey") && msg.get("apiKey").isJsonPrimitive() ? msg.get("apiKey").getAsString() : null;
        System.out.println("[lobby] starting a " + format + " game for " + seats.size());
        // (launch first ends any previous game, which reports back here as over: playing is set after it)
        BridgeMain.launch(setup, "commander".equals(format), key, host);
        playing = true;
        broadcast();
    }

    /** The game is over (or abandoned): back to the lobby, everyone's seat and deck as they were. */
    static synchronized void gameOver() {
        if (!playing) return;
        playing = false;
        for (final Seat s : seats) s.ready = false;
        broadcast();
    }

    private static void leave(final Client c) {
        if (c == host) {
            close("The host closed the lobby.");
            return;
        }
        final Seat s = seatOf(c);
        if (s == null) return;
        final int i = seats.indexOf(s);
        seats.set(i, openSeat(i));
        System.out.println("[lobby] " + c.name + " left");
        if (link != null && c.pipe() != null) link.kick(c.pipe());
        Hub.forget(c);
        broadcast();
    }

    /** Tell a friend their seat is gone, and let them go. */
    private static void dismiss(final Client c, final String reason) {
        final JsonObject m = new JsonObject();
        m.addProperty("type", "lobbyClosed");
        m.addProperty("reason", reason);
        c.send(m);
        if (link != null && c.pipe() != null) link.kick(c.pipe());
        Hub.forget(c);
    }

    /** Close the lobby: friends are told, the relay link is shut. */
    static synchronized void close(final String reason) {
        if (host == null) return;
        for (final Seat s : seats) {
            if (s.client != null && s.client != host) dismiss(s.client, reason);
        }
        if (link != null) link.close();
        link = null;
        seats.clear();
        host = null;
        playing = false;
        System.out.println("[lobby] closed: " + reason);
    }

    // ---- the lobby as each player sees it ------------------------------------------------------------

    private static void broadcast() {
        for (final Seat s : seats) {
            if (s.client != null) s.client.send(stateFor(s.client));
        }
    }

    private static JsonObject stateFor(final Client viewer) {
        final JsonObject o = new JsonObject();
        o.addProperty("type", "lobby");
        o.addProperty("code", link == null ? null : link.code());
        o.addProperty("link", link == null ? null : link.joinLink());
        o.addProperty("format", format);
        o.addProperty("playing", playing);
        o.addProperty("host", viewer == host);
        o.addProperty("problem", problem);
        final JsonArray list = new JsonArray();
        int you = -1;
        for (int i = 0; i < seats.size(); i++) {
            final Seat s = seats.get(i);
            if (s.client == viewer) you = i;
            final JsonObject j = new JsonObject();
            j.addProperty("kind", s.kind);
            j.addProperty("name", s.name);
            j.addProperty("connected", s.client == null || s.client.connected());
            j.addProperty("ready", s.ready || "ai".equals(s.kind) || "open".equals(s.kind));
            j.add("deck", s.info == null ? null : s.info.deepCopy());
            // the host sees (and edits) the AI seats' actual picks
            if (viewer == host && !s.person()) {
                j.add("spec", s.deck == null ? null : s.deck.deepCopy());
                j.addProperty("gameplan", s.gameplan);
            }
            list.add(j);
        }
        o.addProperty("you", you);
        o.add("seats", list);
        return o;
    }

    // ---- helpers ------------------------------------------------------------------------------------

    private static Seat seatOf(final Client c) {
        for (final Seat s : seats) if (s.client == c) return s;
        return null;
    }

    private static String uniqueName(final String wanted, final Seat self) {
        String base = wanted == null || wanted.isBlank() || wanted.equalsIgnoreCase("you") ? "Player" : wanted;
        String name = base;
        for (int n = 2; ; n++) {
            final String candidate = name;
            if (seats.stream().noneMatch(s -> s != self && candidate.equalsIgnoreCase(s.name))) return name;
            name = base + " " + n;
        }
    }

    /** Only the fields a seat spec has, at sane sizes (friends' browsers are not trusted). */
    private static JsonObject cleanDeck(final JsonElement e) {
        if (e == null || !e.isJsonObject()) return null;
        final JsonObject in = e.getAsJsonObject();
        final JsonObject out = new JsonObject();
        if (in.has("precon") && in.get("precon").isJsonPrimitive()) {
            out.addProperty("precon", clip(in.get("precon").getAsString(), 200));
            return out;
        }
        if (!in.has("list") || !in.get("list").isJsonPrimitive()) return null;
        out.addProperty("list", clip(in.get("list").getAsString(), MAX_LIST));
        if (in.has("name") && in.get("name").isJsonPrimitive()) out.addProperty("name", clip(in.get("name").getAsString(), 80));
        if (in.has("commanders") && in.get("commanders").isJsonArray()) {
            final JsonArray cmd = new JsonArray();
            for (final JsonElement x : in.getAsJsonArray("commanders")) {
                if (x.isJsonPrimitive() && cmd.size() < 2) cmd.add(clip(x.getAsString(), 120));
            }
            out.add("commanders", cmd);
        }
        return out;
    }

    private static JsonObject cleanInfo(final JsonElement e) {
        if (e == null || !e.isJsonObject()) return null;
        final JsonObject in = e.getAsJsonObject();
        final JsonObject out = new JsonObject();
        if (in.has("label") && in.get("label").isJsonPrimitive()) out.addProperty("label", clip(in.get("label").getAsString(), 80));
        for (final String key : new String[] { "commanders", "colors" }) {
            if (in.has(key) && in.get(key).isJsonArray()) {
                final JsonArray a = new JsonArray();
                for (final JsonElement x : in.getAsJsonArray(key)) if (x.isJsonPrimitive() && a.size() < 5) a.add(clip(x.getAsString(), 120));
                out.add(key, a);
            }
        }
        if (in.has("face") && in.get("face").isJsonObject()) {
            final JsonObject f = in.getAsJsonObject("face");
            final JsonObject face = new JsonObject();
            for (final String key : new String[] { "name", "set", "cn" }) {
                if (f.has(key) && f.get(key).isJsonPrimitive()) face.addProperty(key, clip(f.get(key).getAsString(), 120));
            }
            out.add("face", face);
        }
        return out;
    }

    private static String clip(final String s, final int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static String str(final JsonObject m, final String key, final String fallback) {
        return m.has(key) && m.get(key).isJsonPrimitive() ? m.get(key).getAsString() : fallback;
    }

    private static int num(final JsonObject m, final String key, final int fallback) {
        try {
            return m.has(key) && m.get(key).isJsonPrimitive() ? m.get(key).getAsInt() : fallback;
        } catch (final RuntimeException e) {
            return fallback;
        }
    }
}

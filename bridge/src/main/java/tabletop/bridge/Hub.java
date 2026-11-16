package tabletop.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.function.Predicate;

/**
 * Everyone connected to this bridge: the browser on this computer and, in an online lobby, friends reaching it
 * through the relay. Connections ({@link Client.Pipe}) come and go; a {@link Client} is the person behind one,
 * recognised by the token their browser sends in its {@code hello}, so a dropped connection can pick up where
 * it left off.
 */
final class Hub {
    private Hub() { }

    private static final Map<String, Client> CLIENTS = new ConcurrentHashMap<>();
    private static final Map<Client.Pipe, Client> BY_PIPE = new ConcurrentHashMap<>();
    /** tokens first seen on a relayed connection; a relayed connection can only ever be one of these */
    private static final java.util.Set<String> REMOTE_TOKENS = ConcurrentHashMap.newKeySet();
    private static volatile BiConsumer<Client, JsonObject> handler = (c, m) -> { };

    static void onMessage(final BiConsumer<Client, JsonObject> h) {
        handler = h;
    }

    static void opened(final Client.Pipe pipe) {
        // nothing yet: the browser introduces itself with a hello (older clients just start talking)
    }

    static void closed(final Client.Pipe pipe) {
        final Client c = BY_PIPE.remove(pipe);
        if (c == null) return;
        c.detach(pipe);
        System.out.println("[bridge] " + c.name + " disconnected");
        final JsonObject gone = new JsonObject();
        gone.addProperty("type", "_disconnected");
        dispatch(c, gone);
    }

    static void text(final Client.Pipe pipe, final String text) {
        final JsonObject msg;
        try {
            msg = JsonParser.parseString(text).getAsJsonObject();
        } catch (final RuntimeException e) {
            System.err.println("[bridge] bad message: " + (text.length() > 200 ? text.substring(0, 200) + "…" : text));
            return;
        }
        final String type = msg.has("type") && msg.get("type").isJsonPrimitive() ? msg.get("type").getAsString() : "";
        if ("hello".equals(type)) {
            hello(pipe, msg);
            return;
        }
        Client c = BY_PIPE.get(pipe);
        if (c == null) {
            // a local browser that skipped the hello (older client, test scripts): one client per connection
            if (pipe.remote()) return;
            c = bind(pipe, "local-" + UUID.randomUUID(), "You");
        }
        if ("response".equals(type)) {
            if (msg.has("id") && msg.get("id").isJsonPrimitive()) c.answer(msg.get("id").getAsInt(), msg.get("value"));
            return;
        }
        dispatch(c, msg);
    }

    /** {type: hello, token, name}: who this connection is. A returning token gets its game back. */
    private static void hello(final Client.Pipe pipe, final JsonObject msg) {
        final String token = msg.has("token") && msg.get("token").isJsonPrimitive() ? msg.get("token").getAsString() : "";
        final String name = msg.has("name") && msg.get("name").isJsonPrimitive() ? cleanName(msg.get("name").getAsString()) : "";
        if (!token.matches("[A-Za-z0-9_-]{16,64}")) {
            System.err.println("[bridge] hello without a usable token");
            return;
        }
        // a relayed connection can never claim a token that belongs to this computer (and the other way round)
        final boolean remoteToken = REMOTE_TOKENS.contains(token);
        final Client existing = CLIENTS.get(token);
        if (existing != null && remoteToken != pipe.remote()) {
            System.err.println("[bridge] refused a hello for a token from the other side");
            return;
        }
        final boolean returning = existing != null;
        final Client c = bind(pipe, token, name.isEmpty() ? (existing != null ? existing.name : "Player") : name);
        final JsonObject welcome = new JsonObject();
        welcome.addProperty("type", "welcome");
        welcome.addProperty("returning", returning && c.gui != null);
        welcome.addProperty("remote", pipe.remote());
        // where friends join (this computer's browser offers "Join a game" by opening the relay's page)
        if (!pipe.remote()) {
            final String relay = RelayLink.relayUrl();
            welcome.addProperty("relay", relay.isEmpty() ? null : relay.replaceFirst("^ws", "http").replaceAll("/+$", ""));
        }
        c.send(welcome);
        if (returning) {
            System.out.println("[bridge] " + c.name + " reconnected");
            c.resync();
        }
        dispatch(c, msg);
    }

    private static Client bind(final Client.Pipe pipe, final String token, final String name) {
        final Client c = CLIENTS.computeIfAbsent(token, t -> new Client(t, name));
        if (pipe.remote()) REMOTE_TOKENS.add(token);
        if (!name.isEmpty()) c.name = name;
        // the same browser on a new connection: the old one is finished
        final Client.Pipe old = c.pipe();
        if (old != null && old != pipe) BY_PIPE.remove(old);
        c.attach(pipe);
        BY_PIPE.put(pipe, c);
        return c;
    }

    private static void dispatch(final Client c, final JsonObject msg) {
        try {
            handler.accept(c, msg);
        } catch (final RuntimeException e) {
            e.printStackTrace();
        }
    }

    /** A player-chosen name: trimmed, at most 24 characters, no control characters. */
    static String cleanName(final String raw) {
        final String s = raw.replaceAll("\\p{Cntrl}", "").trim();
        return s.length() > 24 ? s.substring(0, 24).trim() : s;
    }

    static void broadcast(final JsonObject msg, final Predicate<Client> to) {
        for (final Client c : CLIENTS.values()) {
            if (to.test(c)) c.send(msg);
        }
    }

    static List<Client> all() {
        return new ArrayList<>(CLIENTS.values());
    }

    /** Forget a remote player entirely (they left the lobby for good). */
    static void forget(final Client c) {
        CLIENTS.remove(c.token, c);
        REMOTE_TOKENS.remove(c.token);
        final Client.Pipe p = c.pipe();
        if (p != null) BY_PIPE.remove(p);
    }
}

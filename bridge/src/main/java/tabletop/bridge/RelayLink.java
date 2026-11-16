package tabletop.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * The host's line to the relay, the small service that lets friends reach this game from anywhere with a code.
 * The bridge connects out to the relay (so no router setup is needed); the relay hands out the lobby code and
 * passes messages between this bridge and each friend's browser, tagged with a connection number:
 *
 * <pre>
 *   relay → bridge   {t: "hosted", code, secret}     the lobby is open under this code
 *                    {t: "open",  c}                 a friend connected (connection c)
 *                    {t: "msg",   c, d}              connection c sent d (the game protocol, as text)
 *                    {t: "close", c}                 connection c went away
 *   bridge → relay   {t: "msg",   c, d}              send d to connection c
 *                    {t: "kick",  c}                 close connection c
 * </pre>
 *
 * A dropped link reconnects with the code and secret, keeping the lobby (and the friends) where they were.
 */
final class RelayLink {
    /** where the relay lives: -Drelay.url, or the CLOWNFISH_RELAY environment variable */
    static String relayUrl() {
        final String prop = System.getProperty("relay.url");
        if (prop != null && !prop.isBlank()) return prop.trim();
        final String env = System.getenv("CLOWNFISH_RELAY");
        if (env != null && !env.isBlank()) return env.trim();
        return DEFAULT_RELAY;
    }

    /** The deployed relay (set when it's deployed; empty means online play isn't available in this build). */
    static final String DEFAULT_RELAY = "wss://mtgclownfish-relay.mtgclownfish.workers.dev";

    private final String base;
    private final Consumer<String> onHosted;
    private final Consumer<String> onLost;
    private final Map<Integer, Client.Pipe> pipes = new ConcurrentHashMap<>();
    private volatile WebSocketClient ws;
    private volatile String code;
    private volatile String secret;
    private volatile boolean closed;
    private int retries;

    /**
     * @param onHosted called with the lobby code once the relay has opened it (again after each reconnect)
     * @param onLost   called with a reason when the relay can't be reached and the link gives up
     */
    RelayLink(final String base, final Consumer<String> onHosted, final Consumer<String> onLost) {
        this.base = base.replaceAll("/+$", "");
        this.onHosted = onHosted;
        this.onLost = onLost;
    }

    String code() {
        return code;
    }

    /** The page friends open to join: the relay serves the client too. */
    String joinLink() {
        final String http = base.replaceFirst("^ws", "http");
        return code == null ? null : http + "/?join=" + code;
    }

    void connect() {
        final String url = code == null ? base + "/host"
                : base + "/host?code=" + enc(code) + "&secret=" + enc(secret);
        final WebSocketClient client = new WebSocketClient(URI.create(url)) {
            @Override
            public void onOpen(final ServerHandshake handshake) {
                retries = 0;
            }

            @Override
            public void onMessage(final String text) {
                handle(text);
            }

            @Override
            public void onClose(final int status, final String reason, final boolean remote) {
                dropAll();
                if (closed) return;
                // the lobby is gone on the relay's side (expired, or the code was taken over)
                if (status == 4404 || status == 4403) {
                    closed = true;
                    onLost.accept("The relay closed the lobby (" + reason + ").");
                    return;
                }
                reconnectLater();
            }

            @Override
            public void onError(final Exception ex) {
                System.err.println("[relay] " + ex.getMessage());
            }
        };
        client.setConnectionLostTimeout(30);
        ws = client;
        client.connect();
    }

    private void reconnectLater() {
        if (++retries > 20) {
            closed = true;
            onLost.accept("Lost the connection to the relay.");
            return;
        }
        final long wait = Math.min(15000, 500L * (1L << Math.min(retries, 5)));
        System.out.println("[relay] reconnecting in " + wait + " ms");
        final Thread t = new Thread(() -> {
            try {
                Thread.sleep(wait);
            } catch (final InterruptedException e) {
                return;
            }
            if (!closed) connect();
        }, "relay-reconnect");
        t.setDaemon(true);
        t.start();
    }

    private void handle(final String text) {
        final JsonObject m;
        try {
            m = JsonParser.parseString(text).getAsJsonObject();
        } catch (final RuntimeException e) {
            return;
        }
        final String t = m.has("t") ? m.get("t").getAsString() : "";
        switch (t) {
            case "hosted" -> {
                code = m.get("code").getAsString();
                secret = m.get("secret").getAsString();
                System.out.println("[relay] lobby open: " + code);
                onHosted.accept(code);
            }
            case "open" -> {
                final int c = m.get("c").getAsInt();
                final Client.Pipe pipe = new Client.Pipe() {
                    @Override public void send(final String d) { sendTo(c, d); }
                    @Override public boolean isOpen() { return pipes.get(c) == this && ws != null && ws.isOpen(); }
                    @Override public boolean remote() { return true; }
                };
                pipes.put(c, pipe);
                Hub.opened(pipe);
            }
            case "msg" -> {
                final Client.Pipe pipe = pipes.get(m.get("c").getAsInt());
                if (pipe != null && m.has("d")) Hub.text(pipe, m.get("d").getAsString());
            }
            case "close" -> {
                final Client.Pipe pipe = pipes.remove(m.get("c").getAsInt());
                if (pipe != null) Hub.closed(pipe);
            }
            default -> { }
        }
    }

    private void sendTo(final int c, final String d) {
        final JsonObject m = new JsonObject();
        m.addProperty("t", "msg");
        m.addProperty("c", c);
        m.addProperty("d", d);
        final WebSocketClient w = ws;
        if (w == null || !w.isOpen()) throw new IllegalStateException("relay not connected");
        synchronized (this) {
            w.send(m.toString());
        }
    }

    /** Close one friend's connection (they left the lobby, or were removed). */
    void kick(final Client.Pipe pipe) {
        for (final Map.Entry<Integer, Client.Pipe> e : pipes.entrySet()) {
            if (e.getValue() == pipe) {
                final JsonObject m = new JsonObject();
                m.addProperty("t", "kick");
                m.addProperty("c", e.getKey());
                final WebSocketClient w = ws;
                if (w != null && w.isOpen()) {
                    synchronized (this) {
                        w.send(m.toString());
                    }
                }
            }
        }
    }

    /** The lobby is over: tell the relay and stop reconnecting. */
    void close() {
        closed = true;
        final WebSocketClient w = ws;
        if (w != null) w.close(1000, "lobby closed");
        dropAll();
    }

    private void dropAll() {
        for (final Client.Pipe p : pipes.values()) Hub.closed(p);
        pipes.clear();
    }

    private static String enc(final String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}

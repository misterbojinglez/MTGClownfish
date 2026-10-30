package tabletop.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * The single WebSocket link to the 3D client. Outbound messages leave in the order they were queued,
 * and {@link #request} parks the calling (game) thread until the client answers.
 */
public class Session extends WebSocketServer {
    private static final Gson GSON = new Gson();

    private final BlockingQueue<String> outbox = new LinkedBlockingQueue<>();
    private final Map<Integer, CompletableFuture<JsonElement>> pending = new ConcurrentHashMap<>();
    private final AtomicInteger nextRequestId = new AtomicInteger(1);
    private final Consumer<JsonObject> onClientMessage;
    private volatile WebSocket client;

    public Session(final int port, final Consumer<JsonObject> onClientMessage) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.onClientMessage = onClientMessage;
        setReuseAddr(true);
        final Thread sender = new Thread(this::drainOutbox, "bridge-sender");
        sender.setDaemon(true);
        sender.start();
    }

    public void send(final JsonObject message) {
        outbox.add(GSON.toJson(message));
    }

    /** Ask the client to decide something and wait for the answer. Returns null if the client goes away. */
    public JsonElement request(final String kind, final JsonObject payload) {
        final int id = nextRequestId.getAndIncrement();
        final CompletableFuture<JsonElement> answer = new CompletableFuture<>();
        pending.put(id, answer);
        payload.addProperty("type", "request");
        payload.addProperty("kind", kind);
        payload.addProperty("id", id);
        send(payload);
        try {
            return answer.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException e) {
            return null;
        } finally {
            pending.remove(id);
        }
    }

    private void drainOutbox() {
        while (true) {
            try {
                final String msg = outbox.take();
                WebSocket ws = client;
                while (ws == null || !ws.isOpen()) {
                    Thread.sleep(100);
                    ws = client;
                }
                ws.send(msg);
            } catch (InterruptedException e) {
                return;
            } catch (RuntimeException e) {
                System.err.println("[bridge] send failed: " + e.getMessage());
            }
        }
    }

    @Override
    public void onOpen(final WebSocket conn, final ClientHandshake handshake) {
        client = conn;
        System.out.println("[bridge] client connected");
    }

    @Override
    public void onClose(final WebSocket conn, final int code, final String reason, final boolean remote) {
        if (conn == client) {
            client = null;
            System.out.println("[bridge] client disconnected");
        }
    }

    @Override
    public void onMessage(final WebSocket conn, final String message) {
        final JsonObject msg;
        try {
            msg = JsonParser.parseString(message).getAsJsonObject();
        } catch (RuntimeException e) {
            System.err.println("[bridge] bad message: " + message);
            return;
        }
        if ("response".equals(msg.has("type") ? msg.get("type").getAsString() : null)) {
            final CompletableFuture<JsonElement> answer = pending.get(msg.get("id").getAsInt());
            if (answer != null) {
                answer.complete(msg.get("value"));
            }
            return;
        }
        try {
            onClientMessage.accept(msg);
        } catch (RuntimeException e) {
            e.printStackTrace();
        }
    }

    /** Drops every unanswered request, e.g. when a game is abandoned. */
    public void cancelPending() {
        pending.values().forEach(f -> f.completeExceptionally(new IllegalStateException("cancelled")));
        pending.clear();
    }

    @Override
    public void onError(final WebSocket conn, final Exception ex) {
        System.err.println("[bridge] socket error: " + ex);
    }

    @Override
    public void onStart() {
        System.out.println("[bridge] listening on ws://127.0.0.1:" + getPort());
    }
}

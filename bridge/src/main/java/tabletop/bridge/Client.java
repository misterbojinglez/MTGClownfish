package tabletop.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One person at the table: a browser on this computer, or a friend's browser reaching the game through the
 * relay. A client keeps its identity (its token) across dropped connections: the connection underneath
 * ({@link Pipe}) can be replaced, and on reconnecting the player gets the whole table and any question still
 * waiting for them again.
 *
 * Outbound messages leave in the order they were queued; {@link #request} parks the calling (game) thread
 * until this player answers.
 */
public final class Client {
    private static final Gson GSON = new Gson();

    /** A connection the client is reachable on: a local WebSocket, or a relayed one. */
    public interface Pipe {
        void send(String text);
        boolean isOpen();
        /** whether this connection comes through the relay (a remote player, not this computer) */
        boolean remote();
    }

    final String token;
    volatile String name;
    private volatile Pipe pipe;
    /** how this player wants the table to behave (stops, full control, automation), as their client last sent it */
    volatile JsonObject options = new JsonObject();
    /** the player's game view, while they're in a game */
    volatile SocketGuiGame gui;

    private final BlockingQueue<String> outbox = new LinkedBlockingQueue<>();
    private final Map<Integer, CompletableFuture<JsonElement>> pending = new ConcurrentHashMap<>();
    /** each unanswered question as sent, so a player who reconnects is asked again */
    private final Map<Integer, String> pendingPayloads = new ConcurrentHashMap<>();
    private static final AtomicInteger NEXT_REQUEST = new AtomicInteger(1);

    Client(final String token, final String name) {
        this.token = token;
        this.name = name;
        final Thread sender = new Thread(this::drainOutbox, "bridge-send-" + token);
        sender.setDaemon(true);
        sender.start();
    }

    boolean remote() {
        final Pipe p = pipe;
        return p != null && p.remote();
    }

    boolean connected() {
        final Pipe p = pipe;
        return p != null && p.isOpen();
    }

    Pipe pipe() {
        return pipe;
    }

    /**
     * A (new) connection for this player. Whatever was queued for the old one is dropped: a returning player is
     * brought up to date with a fresh full table instead (see {@link #resync}).
     */
    void attach(final Pipe p) {
        final boolean returning = pipe != null;
        pipe = p;
        if (returning) outbox.clear();
    }

    void detach(final Pipe p) {
        if (pipe == p) pipe = null;
    }

    /** A returning player: the game from scratch (their view, the whole table) and the questions still open. */
    void resync() {
        final SocketGuiGame g = gui;
        if (g != null) g.resend();
        pendingPayloads.values().forEach(outbox::add);
    }

    public void send(final JsonObject message) {
        outbox.add(GSON.toJson(message));
    }

    /** Ask this player to decide something and wait for the answer. Returns null if the game is abandoned. */
    public JsonElement request(final String kind, final JsonObject payload) {
        final int id = NEXT_REQUEST.getAndIncrement();
        final CompletableFuture<JsonElement> answer = new CompletableFuture<>();
        pending.put(id, answer);
        payload.addProperty("type", "request");
        payload.addProperty("kind", kind);
        payload.addProperty("id", id);
        final String text = GSON.toJson(payload);
        pendingPayloads.put(id, text);
        outbox.add(text);
        try {
            return answer.get();
        } catch (final InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (final ExecutionException e) {
            return null;
        } finally {
            pending.remove(id);
            pendingPayloads.remove(id);
        }
    }

    /** The player's answer to a question. */
    void answer(final int id, final JsonElement value) {
        final CompletableFuture<JsonElement> f = pending.get(id);
        if (f != null) f.complete(value);
    }

    /** Drops every unanswered question, e.g. when a game is abandoned. */
    void cancelPending() {
        pending.values().forEach(f -> f.completeExceptionally(new IllegalStateException("cancelled")));
        pending.clear();
        pendingPayloads.clear();
    }

    private void drainOutbox() {
        while (true) {
            try {
                final String msg = outbox.take();
                Pipe p = pipe;
                while (p == null || !p.isOpen()) {
                    Thread.sleep(100);
                    p = pipe;
                }
                p.send(msg);
            } catch (final InterruptedException e) {
                return;
            } catch (final RuntimeException e) {
                System.err.println("[bridge] send to " + name + " failed: " + e.getMessage());
            }
        }
    }
}

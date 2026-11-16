package tabletop.bridge;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The bridge's WebSocket server for browsers on this computer (it only listens on 127.0.0.1; friends in an
 * online game come in through {@link RelayLink}). Each connection becomes a {@link Client.Pipe} handed to the
 * {@link Hub}.
 */
public class Session extends WebSocketServer {
    private final Map<WebSocket, Client.Pipe> pipes = new ConcurrentHashMap<>();

    public Session(final int port) {
        super(new InetSocketAddress("127.0.0.1", port));
        setReuseAddr(true);
    }

    @Override
    public void onOpen(final WebSocket conn, final ClientHandshake handshake) {
        final Client.Pipe pipe = new Client.Pipe() {
            @Override public void send(final String text) { conn.send(text); }
            @Override public boolean isOpen() { return conn.isOpen(); }
            @Override public boolean remote() { return false; }
        };
        pipes.put(conn, pipe);
        Hub.opened(pipe);
        System.out.println("[bridge] client connected");
    }

    @Override
    public void onClose(final WebSocket conn, final int code, final String reason, final boolean remote) {
        final Client.Pipe pipe = pipes.remove(conn);
        if (pipe != null) Hub.closed(pipe);
    }

    @Override
    public void onMessage(final WebSocket conn, final String message) {
        final Client.Pipe pipe = pipes.get(conn);
        if (pipe != null) Hub.text(pipe, message);
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

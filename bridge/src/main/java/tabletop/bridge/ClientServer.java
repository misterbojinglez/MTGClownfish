package tabletop.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Serves the built client (client/dist) for the shareable package, so a tester needs only Java: the bridge
 * hands out the page on 127.0.0.1 and the page talks to the bridge's WebSocket as usual. Development keeps
 * using Vite; this only starts when -Dclient.dir is given.
 */
final class ClientServer {

    private static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("json", "application/json"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"),
            Map.entry("jpeg", "image/jpeg"),
            Map.entry("webp", "image/webp"),
            Map.entry("mp3", "audio/mpeg"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("ico", "image/x-icon"));

    private ClientServer() { }

    static void start(final Path root, final int port) throws IOException {
        final Path base = root.toAbsolutePath().normalize();
        // only this machine: testers play locally
        final HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", (HttpExchange ex) -> {
            try (ex) {
                String path = ex.getRequestURI().getPath();
                if (path.isEmpty() || path.equals("/")) {
                    path = "/index.html";
                }
                final Path file = base.resolve(path.substring(1)).normalize();
                // never outside the client folder
                if (!file.startsWith(base) || !Files.isRegularFile(file)) {
                    ex.sendResponseHeaders(404, -1);
                    return;
                }
                final String name = file.getFileName().toString();
                final String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
                ex.getResponseHeaders().set("Content-Type", TYPES.getOrDefault(ext, "application/octet-stream"));
                final byte[] body = Files.readAllBytes(file);
                ex.sendResponseHeaders(200, body.length);
                try (OutputStream out = ex.getResponseBody()) {
                    out.write(body);
                }
            }
        });
        server.start();
        System.out.println("[bridge] game page at http://127.0.0.1:" + port + "/");
    }
}

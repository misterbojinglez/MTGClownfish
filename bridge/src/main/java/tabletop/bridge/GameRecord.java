package tabletop.bridge;

import forge.game.Game;
import forge.game.card.Card;
import forge.game.event.GameEvent;
import forge.game.event.GameEventTurnBegan;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Keeps a readable record of every game in logs/: Forge's own game log ("AI 2 sacrifices Grizzly Bears"),
 * plus each player's life and battlefield at the start of every turn. Rules questions get settled from it.
 */
final class GameRecord {
    private static PrintWriter out;
    /** how many of Forge's game-log entries are already written */
    private static int written;

    private GameRecord() { }

    static synchronized void begin(final String format, final int players) {
        close();
        try {
            final File dir = new File(System.getProperty("bridge.logs", System.getProperty("user.home") + "/mtg-tabletop/logs"));
            dir.mkdirs();
            final String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss"));
            out = new PrintWriter(new FileWriter(new File(dir, "game-" + stamp + ".log")), true);
            written = 0;
            out.println("# " + format + ", " + players + " players, " + stamp);
        } catch (final IOException e) {
            System.err.println("[bridge] can't write the game record: " + e.getMessage());
            out = null;
        }
    }

    static synchronized void onEvent(final Game game, final GameEvent event) {
        if (out == null) {
            return;
        }
        try {
            // everything Forge logged since the last event: casts, resolutions, sacrifices, combat, life
            final int size = game.getGameLog().size();
            if (size > written) {
                final java.util.List<forge.game.GameLogEntry> all = game.getGameLog().getAllEntries();
                for (int i = written; i < all.size(); i++) {
                    final forge.game.GameLogEntry e = all.get(i);
                    if (e.type() != forge.game.GameLogEntryType.MANA) {
                        out.println("  " + e.message().replaceAll("\\s+", " "));
                    }
                }
                written = all.size();
            }
            if (event instanceof GameEventTurnBegan began) {
                out.println();
                out.println("== Turn " + game.getPhaseHandler().getTurn() + " (" + began.turnOwner().getName() + ")");
                for (final Player p : game.getPlayers()) {
                    final StringBuilder sb = new StringBuilder();
                    for (final Card c : p.getCardsIn(ZoneType.Battlefield)) {
                        if (c.isLand()) {
                            continue;
                        }
                        if (sb.length() > 0) {
                            sb.append(", ");
                        }
                        sb.append(c.getName());
                        if (c.isToken()) {
                            sb.append(" [token]");
                        }
                        if (c.isCreature()) {
                            sb.append(" ").append(c.getNetPower()).append("/").append(c.getNetToughness());
                        }
                    }
                    out.println("   " + p.getName() + (p.hasLost() ? " (out)" : "") + " · life " + p.getLife() + " · " + sb);
                }
            }
        } catch (final RuntimeException ignored) {
            // the record is best effort; never let it disturb the game
        }
    }

    static synchronized void close() {
        if (out != null) {
            out.close();
            out = null;
        }
    }
}

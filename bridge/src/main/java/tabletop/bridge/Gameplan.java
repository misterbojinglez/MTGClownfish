package tabletop.bridge;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.JsonValue;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.errors.CredentialResolutionException;
import com.anthropic.errors.NoCredentialsException;
import com.anthropic.errors.PermissionDeniedException;
import com.anthropic.errors.RateLimitException;
import com.anthropic.errors.UnauthorizedException;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.StopReason;
import com.anthropic.models.messages.StructuredMessage;
import com.anthropic.models.messages.StructuredMessageCreateParams;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.item.PaperCard;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * An opponent's gameplan, written by the player in plain language ("prioritize transforming Sephiroth as many
 * times as possible"), turned into what Forge's AI can act on: per-card cast priority, value, sacrifice and
 * discard fodder, and a few decisions the bridge makes for it (see {@link PlannedAi}).
 *
 * One Claude request per deck + gameplan, cached on disk, so a game only waits on it the first time.
 */
public final class Gameplan {
    private Gameplan() { }

    /** Bumped when the prompt or the plan's shape changes, so older cached plans are made again. */
    private static final int VERSION = 1;
    private static final String MODEL = "claude-opus-5-5";
    private static final ObjectMapper JSON = new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    // ---- the plan, as Claude returns it (the JSON schema is derived from these records) -----------------

    public record Plan(
            @JsonPropertyDescription("One or two plain sentences for the player: how the AI will now play this deck.")
            String summary,
            @JsonPropertyDescription("Overall stance in combat: \"aggressive\" (attacks and trades freely), \"balanced\", or \"defensive\" (holds back, blocks, plays the long game).")
            String stance,
            @JsonPropertyDescription("True when the plan wants creature tokens treated as fuel: sacrificed before any nontoken card.")
            boolean tokensAreFodder,
            @JsonPropertyDescription("Only the cards the gameplan says something about (usually 5 to 30). Cards left out keep Forge's normal judgement.")
            List<CardHint> cards) { }

    public record CardHint(
            @JsonPropertyDescription("The card's name exactly as it appears in the deck list.")
            String name,
            @JsonPropertyDescription("How much sooner to cast or activate it than Forge otherwise would, from -10 (hold it back) to 20 (cast it as soon as it's sensible). 0 = unchanged; 3 to 8 is a clear preference.")
            int castPriority,
            @JsonPropertyDescription("Extra worth when the AI weighs this creature against others (what to protect, trade, or sacrifice last), from -100 to 300. A typical creature is worth 100 to 250 on Forge's scale; 150+ makes it a crown jewel. 0 = unchanged. Only matters for creatures.")
            int value,
            @JsonPropertyDescription("0 = not fodder. 1 to 5 = happily sacrificed when a cost or effect asks for a sacrifice, 5 first.")
            int sacrificeFodder,
            @JsonPropertyDescription("0 = not fodder. 1 to 5 = discarded first when the AI must discard, 5 first.")
            int discardFodder,
            @JsonPropertyDescription("Cast it in the first main phase, before combat.")
            boolean castBeforeCombat,
            @JsonPropertyDescription("A key piece: never sacrificed or discarded while anything else will do, kept out of attacks and blocks where it would die unless the game depends on it.")
            boolean protect,
            @JsonPropertyDescription("An engine of the plan: always say yes to its optional \"you may\" triggers (\"you may sacrifice another creature\", \"you may draw\") when they can be paid.")
            boolean engine) { }

    // ---- making one ----------------------------------------------------------------------------------

    /** Why a plan couldn't be made: noKey (ask for an API key), or a message for the player. */
    public static final class GameplanException extends Exception {
        public final boolean noKey;

        GameplanException(final String message, final boolean noKey) {
            super(message);
            this.noKey = noKey;
        }
    }

    private static final String SYSTEM = """
            You configure the AI opponent in a Magic: The Gathering program built on the Forge rules engine.
            The player has written, in plain language, how they want the AI to pilot one deck. Forge's AI is
            rule-based: it judges one decision at a time and can't follow a written plan, so your job is to
            translate the gameplan into the settings Forge does act on, card by card.

            The settings you control:
            - castPriority: Forge orders its candidate plays by a score; this is added to it. It changes what the AI
              casts first when it has several options, not whether a play it considers bad gets made.
            - value: added to Forge's evaluation of a creature (its usual scale runs about 100 to 250 for typical
              creatures). Higher means the AI protects it, avoids trading it, sacrifices it last, and opponents'
              effects are weighed as more threatening to it.
            - sacrificeFodder / discardFodder: the cards to give up first when something must be sacrificed or
              discarded. Sacrifice outlets, "dies" payoffs and token strategies want plenty of fodder.
            - castBeforeCombat: cast it in main phase 1 (for creatures with haste, anthems, attack-trigger setups).
            - protect: the program keeps it out of losing attacks and chump blocks, and never gives it up while
              something else will do.
            - engine: the program always accepts its optional triggers when their cost can be paid. Use it for cards
              whose "you may ..." is the point of the plan.
            - stance and tokensAreFodder: deck-wide combat posture and treatment of creature tokens.

            Work from the cards' rules text, provided with the list, not from memory: some cards are newer than you.
            Think about what the plan needs mechanically (enablers, payoffs, fuel, protection) and set every card
            that serves or threatens it, not just the ones named. Leave out cards the plan doesn't touch. Use names
            exactly as written in the list. Keep values moderate unless the plan clearly calls for extremes: a
            castPriority of 20 on everything is the same as nothing.
            """;

    /** The cached plan for this deck and gameplan, if one was made before. */
    public static Optional<Plan> cached(final Deck deck, final String gameplan) {
        final Path file = cacheFile(deck, gameplan);
        if (!Files.isRegularFile(file)) return Optional.empty();
        try {
            return Optional.of(JSON.readValue(file.toFile(), Plan.class));
        } catch (final IOException e) {
            System.err.println("[gameplan] unreadable cache " + file + ": " + e.getMessage());
            return Optional.empty();
        }
    }

    /**
     * The plan for this deck and gameplan: from the cache, or made with one Claude request. apiKey may be null
     * (then the SDK's own lookup: ANTHROPIC_API_KEY, or a profile from `ant auth login`).
     */
    public static Plan make(final Deck deck, final String gameplan, final String apiKey) throws GameplanException {
        final Optional<Plan> hit = cached(deck, gameplan);
        if (hit.isPresent()) return hit.get();

        final AnthropicClient client;
        try {
            client = apiKey != null && !apiKey.isBlank()
                    ? AnthropicOkHttpClient.builder().apiKey(apiKey.trim()).build()
                    : AnthropicOkHttpClient.fromEnv();
        } catch (final RuntimeException e) {
            throw new GameplanException("No Claude API key: add one to turn gameplans into AI settings.", true);
        }

        final StructuredMessageCreateParams<Plan> params = MessageCreateParams.builder()
                .model(MODEL)
                .maxTokens(32000L)
                .system(SYSTEM)
                // (effort stays at the model's default, medium: plenty for reading a deck list)
                // a refused request is retried on a fallback model instead of just stopping
                .putAdditionalHeader("anthropic-beta", "server-side-fallback-2026-07-01")
                .putAdditionalBodyProperty("fallbacks", JsonValue.from("default"))
                .outputConfig(Plan.class)
                .addUserMessage(prompt(deck, gameplan))
                .build();

        final long t0 = System.currentTimeMillis();
        final Message raw;
        final Plan plan;
        try {
            final StructuredMessage<Plan> response = client.messages().create(params);
            raw = response.rawMessage();
            if (raw.stopReason().filter(r -> r.equals(StopReason.REFUSAL)).isPresent()) {
                throw new GameplanException("Claude declined to plan this deck. Try rewording the gameplan.", false);
            }
            if (raw.stopReason().filter(r -> r.equals(StopReason.MAX_TOKENS)).isPresent()) {
                throw new GameplanException("The plan came back cut short. Try a shorter gameplan.", false);
            }
            plan = response.content().stream()
                    .flatMap(block -> block.text().stream())
                    .map(typed -> typed.text())
                    .findFirst()
                    .orElseThrow(() -> new GameplanException("Claude sent no plan back. Try again.", false));
        } catch (final NoCredentialsException | CredentialResolutionException e) {
            throw new GameplanException("No Claude API key: add one to turn gameplans into AI settings.", true);
        } catch (final UnauthorizedException | PermissionDeniedException e) {
            final boolean gaveKey = apiKey != null && !apiKey.isBlank();
            throw new GameplanException(gaveKey ? "That Claude API key wasn't accepted." : "No Claude API key: add one to turn gameplans into AI settings.", true);
        } catch (final RateLimitException e) {
            throw new GameplanException("Claude is busy right now (rate limited). Try again in a minute.", false);
        } catch (final AnthropicServiceException e) {
            throw new GameplanException("Claude couldn't make the plan (" + e.statusCode() + "): " + e.getMessage(), false);
        } catch (final GameplanException e) {
            throw e;
        } catch (final RuntimeException e) {
            // no credentials found by the SDK, network down, a plan that didn't parse
            final String m = String.valueOf(e.getMessage());
            final boolean noKey = m.toLowerCase().contains("api key") || m.toLowerCase().contains("apikey") || m.toLowerCase().contains("credential");
            throw new GameplanException(noKey ? "No Claude API key: add one to turn gameplans into AI settings." : "Couldn't reach Claude: " + m, noKey);
        }
        final Plan clean = sanitize(plan);
        System.out.println("[gameplan] " + deck.getName() + ": " + clean.cards().size() + " cards set in "
                + (System.currentTimeMillis() - t0) + " ms (" + raw.usage().inputTokens() + " in / " + raw.usage().outputTokens() + " out)");
        try {
            final Path file = cacheFile(deck, gameplan);
            Files.createDirectories(file.getParent());
            JSON.writerWithDefaultPrettyPrinter().writeValue(file.toFile(), clean);
        } catch (final IOException e) {
            System.err.println("[gameplan] couldn't cache the plan: " + e.getMessage());
        }
        return clean;
    }

    /** A plan written by hand (test tooling: -Dbridge.dev=true lets a seat bring one), cleaned up like Claude's. */
    public static Plan parse(final String json) throws IOException {
        return sanitize(JSON.readValue(json, Plan.class));
    }

    /** Clamp everything into the ranges the prompt promised, and drop names that aren't in the deck. */
    private static Plan sanitize(final Plan p) {
        final List<CardHint> cards = new ArrayList<>();
        if (p.cards() != null) {
            for (final CardHint c : p.cards()) {
                if (c == null || c.name() == null || c.name().isBlank()) continue;
                cards.add(new CardHint(c.name().trim(), clamp(c.castPriority(), -10, 20), clamp(c.value(), -100, 300),
                        clamp(c.sacrificeFodder(), 0, 5), clamp(c.discardFodder(), 0, 5), c.castBeforeCombat(), c.protect(), c.engine()));
            }
        }
        final String stance = p.stance() == null ? "balanced" : p.stance().trim().toLowerCase();
        return new Plan(p.summary() == null ? "" : p.summary().trim(),
                stance.equals("aggressive") || stance.equals("defensive") ? stance : "balanced", p.tokensAreFodder(), cards);
    }

    private static int clamp(final int v, final int lo, final int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /** The deck with each card's rules text, then the player's gameplan. */
    private static String prompt(final Deck deck, final String gameplan) {
        final StringBuilder sb = new StringBuilder();
        sb.append("Deck: ").append(deck.getName()).append("\n\n");
        final CardPool commanders = deck.get(DeckSection.Commander);
        if (commanders != null && !commanders.isEmpty()) {
            sb.append("Commander(s):\n");
            appendCards(sb, commanders);
            sb.append('\n');
        }
        sb.append("Main deck:\n");
        appendCards(sb, deck.getMain());
        sb.append("\n<gameplan>\n").append(gameplan.trim()).append("\n</gameplan>\n");
        return sb.toString();
    }

    private static void appendCards(final StringBuilder sb, final CardPool pool) {
        for (final Map.Entry<PaperCard, Integer> e : pool) {
            final PaperCard pc = e.getKey();
            final var rules = pc.getRules();
            sb.append(e.getValue()).append("x ").append(pc.getName());
            if (rules != null) {
                final String cost = rules.getManaCost() == null ? "" : rules.getManaCost().toString();
                sb.append(" | ").append(cost.isEmpty() ? "-" : cost).append(" | ").append(rules.getType());
                final String text = rules.getOracleText();
                if (text != null && !text.isBlank()) sb.append(" | ").append(text.replace("\\n", " / ").replace('\n', ' '));
            }
            sb.append('\n');
        }
    }

    /** ~/.mtg-clownfish/gameplans/<hash of the deck's cards, the gameplan and the version>.json */
    private static Path cacheFile(final Deck deck, final String gameplan) {
        final StringBuilder key = new StringBuilder("v").append(VERSION).append('\n');
        final CardPool commanders = deck.get(DeckSection.Commander);
        if (commanders != null) for (final Map.Entry<PaperCard, Integer> e : commanders) key.append("C ").append(e.getKey().getName()).append('\n');
        final List<String> main = new ArrayList<>();
        for (final Map.Entry<PaperCard, Integer> e : deck.getMain()) main.add(e.getValue() + " " + e.getKey().getName());
        main.sort(String::compareTo);
        main.forEach(s -> key.append(s).append('\n'));
        key.append("\n").append(gameplan.trim());
        try {
            final byte[] hash = MessageDigest.getInstance("SHA-256").digest(key.toString().getBytes(StandardCharsets.UTF_8));
            return Path.of(System.getProperty("user.home"), ".mtg-clownfish", "gameplans", HexFormat.of().formatHex(hash, 0, 16) + ".json");
        } catch (final NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

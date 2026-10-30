package tabletop.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.event.GameEvent;
import forge.game.event.GameEventCardDamaged;
import forge.game.event.GameEventPlayerDamaged;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.AbstractGuiGame;
import forge.gamemodes.match.Selection;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.player.PlayerZoneUpdate;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Forge's view of "the screen" for the human seat. Every visual update becomes an {@code update}
 * message and every question becomes a blocking {@code request} answered by the 3D client.
 */
public class SocketGuiGame extends AbstractGuiGame {
    private final Session session;
    private final Object snapshotLock = new Object();
    private final Map<Integer, String> sentCards = new HashMap<>();
    private final List<JsonObject> pendingEvents = new ArrayList<>();

    private JsonObject prompt = new JsonObject();
    private int seq = 0;

    public SocketGuiGame(final Session session) {
        this.session = session;
        prompt.addProperty("message", "");
    }

    // ---- outbound state ----------------------------------------------------------------------

    /** Called on the game thread for every engine event, so the snapshot matches the moment it describes. */
    public void onGameEvent(final GameEvent event) {
        synchronized (snapshotLock) {
            pendingEvents.add(Serializer.event(event));
            // Forge reports each creature's damage separately; hold damage until the next other event so a
            // whole combat damage step (attackers and blockers striking at once) reaches the client together
            if (event instanceof GameEventCardDamaged || event instanceof GameEventPlayerDamaged) {
                scheduleFallbackFlush();
                return;
            }
            flushLocked();
        }
    }

    private final java.util.concurrent.ScheduledExecutorService flushTimer =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
                final Thread t = new Thread(r, "bridge-flush-timer");
                t.setDaemon(true);
                return t;
            });

    /** If nothing follows the held damage, send it anyway after a moment. */
    private void scheduleFallbackFlush() {
        flushTimer.schedule(() -> {
            synchronized (snapshotLock) {
                if (!pendingEvents.isEmpty()) {
                    flushLocked();
                }
            }
        }, 150, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    private void flush() {
        synchronized (snapshotLock) {
            flushLocked();
        }
    }

    private void flushLocked() {
        if (getGameView() == null) {
            return;
        }
        // Forge refreshes its combat view only between steps; attackers and blockers being declared right
        // now live on the game's Combat, so pull them into the view before every snapshot
        try {
            if (getGameView().getGame() != null) {
                getGameView().getGame().updateCombatForView();
            }
        } catch (RuntimeException ignored) {
            // combat mid-change on another thread; the next snapshot catches up
        }
        final JsonObject state;
        try {
            state = Serializer.game(getGameView(), this::mayView);
        } catch (RuntimeException e) {
            // the engine is mid-mutation on another thread; the next event re-sends everything
            return;
        }
        // only cards whose JSON changed travel; the client keeps the rest
        final JsonObject allCards = state.remove("cards").getAsJsonObject();
        // cards offered for selection from hidden zones (searching a library, looking at a hand) must reach
        // the client too, or it has nothing to show the player
        for (final CardView cv : getSelection().cards()) {
            if (cv != null && !allCards.has(String.valueOf(cv.getId()))) {
                allCards.add(String.valueOf(cv.getId()), Serializer.card(cv, mayView(cv)));
            }
        }
        final JsonObject changed = new JsonObject();
        for (final Map.Entry<String, JsonElement> e : allCards.entrySet()) {
            final String json = e.getValue().toString();
            final Integer id = Integer.valueOf(e.getKey());
            if (!json.equals(sentCards.get(id))) {
                sentCards.put(id, json);
                changed.add(e.getKey(), e.getValue());
            }
        }
        // Cards that dropped out of every listed zone (mid-cast, back to the library) still get their new
        // zone sent, so the client never has to guess where a vanished card went.
        for (final Map.Entry<Integer, String> e : sentCards.entrySet()) {
            final String key = String.valueOf(e.getKey());
            if (allCards.has(key)) { continue; }
            final CardView cv = getGameView().getTracker().getObj(forge.trackable.TrackableTypes.CardViewType, e.getKey());
            if (cv == null) { continue; }
            final JsonObject json = Serializer.card(cv, mayView(cv));
            final String text = json.toString();
            if (!text.equals(e.getValue())) {
                e.setValue(text);
                changed.add(key, json);
            }
        }
        state.add("cards", changed);

        final JsonObject msg = new JsonObject();
        msg.addProperty("type", "update");
        msg.addProperty("seq", ++seq);
        final JsonArray events = new JsonArray();
        pendingEvents.forEach(events::add);
        pendingEvents.clear();
        msg.add("events", events);
        msg.add("state", state);
        msg.add("prompt", prompt.deepCopy());
        msg.add("selection", Serializer.selection(getSelection()));
        session.send(msg);
    }

    public void resetForNewGame() {
        synchronized (snapshotLock) {
            sentCards.clear();
            pendingEvents.clear();
        }
    }

    @Override
    protected void updateCurrentPlayer(final PlayerView player) {
        flush();
    }

    @Override
    public void openView(final TrackableCollection<PlayerView> myPlayers) {
        final JsonObject msg = new JsonObject();
        msg.addProperty("type", "gameStarted");
        final JsonArray you = new JsonArray();
        myPlayers.forEach(p -> you.add(p.getId()));
        msg.add("you", you);
        session.send(msg);
        flush();
    }

    @Override public void showCombat() { flush(); }
    @Override public void updatePhase(final boolean saveState) { flush(); }
    @Override public void updateTurn(final PlayerView player) { flush(); }
    @Override public void updateStack() { flush(); }
    @Override public void updateZones(final Iterable<PlayerZoneUpdate> zonesToUpdate) { flush(); }
    @Override public void updateCards(final Iterable<CardView> cards) { flush(); }
    @Override public void updateManaPool(final Iterable<PlayerView> manaPoolUpdate) { flush(); }
    @Override public void updateLives(final Iterable<PlayerView> livesUpdate) { flush(); }
    @Override public void refreshField() { flush(); }

    @Override
    public void setSelection(final Selection selection) {
        super.setSelection(selection);
        flush();
    }

    @Override
    public void showPromptMessage(final PlayerView playerView, final String message, final CardView card) {
        synchronized (snapshotLock) {
            prompt.addProperty("message", message == null ? "" : message);
            prompt.addProperty("card", card == null ? null : card.getId());
        }
        flush();
    }

    @Override
    public void updateButtons(final PlayerView owner, final String label1, final String label2, final boolean enable1, final boolean enable2, final boolean focus1) {
        synchronized (snapshotLock) {
            final JsonObject ok = new JsonObject();
            ok.addProperty("label", label1);
            ok.addProperty("enabled", enable1);
            ok.addProperty("focus", focus1);
            final JsonObject cancel = new JsonObject();
            cancel.addProperty("label", label2);
            cancel.addProperty("enabled", enable2);
            prompt.add("ok", ok);
            prompt.add("cancel", cancel);
            // which Forge input is asking (e.g. InputPayManaOfCostPayment), so the client can react to it
            prompt.addProperty("input", currentInputName());
        }
        flush();
    }

    /**
     * Forge calls this the moment an input finishes (including auto-passes). Until the next input shows
     * its own buttons the player has nothing to answer, so the client must not offer a live OK button.
     */
    @Override
    public void awaitNextInput() {
        super.awaitNextInput();
        synchronized (snapshotLock) {
            for (final String b : new String[] {"ok", "cancel"}) {
                if (prompt.has(b)) {
                    prompt.getAsJsonObject(b).addProperty("enabled", false);
                }
            }
        }
        flush();
    }

    private String currentInputName() {
        if (getGameController() instanceof forge.player.PlayerControllerHuman pch) {
            final var input = pch.getInputQueue().getInput();
            return input == null ? null : input.getClass().getSimpleName();
        }
        return null;
    }

    @Override public void flashIncorrectAction() { notice("incorrect", null); }
    @Override public void alertUser() { notice("alert", null); }

    @Override
    public void finishGame() {
        flush();
        notice("gameFinished", getGameView().isGameOver() ? getGameView().getWinningPlayerName() : null);
    }

    @Override public void setPanelSelection(final CardView hostCard) { }
    @Override public void setCard(final CardView card) { }
    @Override public void setPlayerAvatar(final LobbyPlayer player, final IHasIcon ihi) { }
    /**
     * Arena-style phase stops. With an empty stack the player only gets priority at these steps; at any of
     * them Forge's auto-pass still skips the stop when there is nothing castable or activatable.
     */
    @Override
    public boolean isUiSetToSkipPhase(final PlayerView playerTurn, final PhaseType phase) {
        if (playerTurn == null || phase == null) {
            return false;
        }
        final boolean myTurn = isLocalPlayer(playerTurn);
        final boolean stop = myTurn
                ? phase == PhaseType.MAIN1 || phase == PhaseType.MAIN2 || phase == PhaseType.COMBAT_DECLARE_BLOCKERS
                : phase == PhaseType.COMBAT_DECLARE_ATTACKERS || phase == PhaseType.COMBAT_DECLARE_BLOCKERS || phase == PhaseType.END_OF_TURN;
        return !stop;
    }

    private void notice(final String kind, final String text) {
        final JsonObject msg = new JsonObject();
        msg.addProperty("type", "notice");
        msg.addProperty("kind", kind);
        msg.addProperty("text", text);
        session.send(msg);
    }

    // ---- questions for the player ------------------------------------------------------------

    private static <T> JsonObject option(final T item, final FSerializableFunction<T, String> display) {
        final JsonObject o = new JsonObject();
        String label = display != null ? display.apply(item) : null;
        if (item instanceof CardView c) {
            o.addProperty("card", c.getId());
            // full details, because choices often come from zones the client never sees (library, hands)
            o.add("cardData", Serializer.card(c, true));
            if (label == null) { label = c.getName(); }
        } else if (item instanceof SpellAbilityView sa) {
            o.addProperty("ability", sa.getId());
            if (sa.getHostCard() != null) { o.addProperty("card", sa.getHostCard().getId()); }
            if (label == null) { label = sa.getDescription(); }
        } else if (item instanceof PlayerView p) {
            o.addProperty("player", p.getId());
            if (label == null) { label = p.getName(); }
        } else if (item instanceof GameEntityView e) {
            o.addProperty("entity", e.getId());
        }
        o.addProperty("label", label == null ? String.valueOf(item) : label);
        return o;
    }

    private static <T> JsonArray options(final List<T> items, final FSerializableFunction<T, String> display) {
        final JsonArray arr = new JsonArray();
        for (final T item : items) {
            arr.add(option(item, display));
        }
        return arr;
    }

    private static List<Integer> indices(final JsonElement answer) {
        final List<Integer> out = new ArrayList<>();
        if (answer != null && answer.isJsonArray()) {
            answer.getAsJsonArray().forEach(e -> out.add(e.getAsInt()));
        }
        return out;
    }

    private <T> List<T> pick(final String message, final int min, final int max, final List<T> choices, final FSerializableFunction<T, String> display, final CardView card) {
        final JsonObject req = new JsonObject();
        req.addProperty("message", message);
        req.addProperty("min", min);
        req.addProperty("max", max);
        req.addProperty("card", card == null ? null : card.getId());
        req.add("options", options(choices, display));
        final List<T> out = new ArrayList<>();
        for (final int i : indices(session.request("choose", req))) {
            if (i >= 0 && i < choices.size()) {
                out.add(choices.get(i));
            }
        }
        return out;
    }

    @Override
    public <T> List<T> getChoices(final String message, final int min, final int max, final List<T> choices, final List<T> selected, final FSerializableFunction<T, String> display) {
        if (choices == null || choices.isEmpty()) {
            return new ArrayList<>();
        }
        if (min < 0 && message != null && message.toLowerCase().contains("play these cards well")) {
            // Forge's deck-quality warning about AI decks; not something the player needs to see
            return new ArrayList<>();
        }
        if (min < 0) {
            // a reveal: nothing to choose, the client just shows it
            final JsonObject req = new JsonObject();
            req.addProperty("message", message);
            req.add("options", options(choices, display));
            session.request("reveal", req);
            return new ArrayList<>();
        }
        return pick(message, min, max, choices, display, null);
    }

    @Override
    public <T> OrderResult<T> order(final String title, final String top, final int remainingObjectsMin, final int remainingObjectsMax, final List<T> sourceChoices, final List<T> destChoices, final CardView referenceCard, final boolean sideboardingMode, final boolean showRememberCheckbox) {
        final JsonObject req = new JsonObject();
        req.addProperty("message", title);
        req.addProperty("caption", top);
        req.addProperty("minRemaining", remainingObjectsMin);
        req.addProperty("maxRemaining", remainingObjectsMax);
        req.add("options", options(sourceChoices, null));
        final List<T> ordered = new ArrayList<>();
        for (final int i : indices(session.request("order", req))) {
            if (i >= 0 && i < sourceChoices.size()) {
                ordered.add(sourceChoices.get(i));
            }
        }
        if (ordered.isEmpty() && remainingObjectsMax <= 0) {
            ordered.addAll(sourceChoices);
        }
        return new OrderResult<>(ordered, false);
    }

    @Override
    public SpellAbilityView getAbilityToPlay(final CardView hostCard, final List<SpellAbilityView> abilities, final ITriggerEvent triggerEvent) {
        if (abilities.isEmpty()) {
            return null;
        }
        if (abilities.size() == 1) {
            return abilities.get(0);
        }
        final List<SpellAbilityView> chosen = pick("Choose an ability", 0, 1, abilities, null, hostCard);
        return chosen.isEmpty() ? null : chosen.get(0);
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(final CardView attacker, final List<CardView> blockers, final int damage, final GameEntityView defender, final boolean overrideOrder, final boolean maySkip) {
        // Lethal to each blocker in order, the rest tramples over (or piles on the last blocker).
        final Map<CardView, Integer> out = new LinkedHashMap<>();
        int remaining = damage;
        for (int i = 0; i < blockers.size() && remaining > 0; i++) {
            final CardView b = blockers.get(i);
            final int lethal = Math.max(1, b.getLethalDamage());
            final int dealt = Math.min(lethal, remaining);
            out.put(b, dealt);
            remaining -= dealt;
        }
        if (remaining > 0) {
            final boolean trample = attacker.getCurrentState().hasTrample();
            if (defender != null && (trample || blockers.isEmpty())) {
                out.put(null, remaining);
            } else if (!blockers.isEmpty()) {
                out.merge(blockers.get(blockers.size() - 1), remaining, Integer::sum);
            }
        }
        return out;
    }

    /**
     * Dividing an amount among several things ("3 damage divided as you choose", counters, shields,
     * mana of any combination). The player sets each share; the client only confirms a full split.
     */
    @Override
    public Map<Object, Integer> assignGenericAmount(final CardView effectSource, final Map<Object, Integer> target, final int amount, final boolean atLeastOne, final String amountLabel) {
        final List<Object> keys = new ArrayList<>(target.keySet());
        final JsonObject req = new JsonObject();
        req.addProperty("message", (effectSource == null ? "" : effectSource.getName() + ": ") + "Divide " + amount + " " + (amountLabel == null ? "" : amountLabel));
        req.addProperty("amount", amount);
        req.addProperty("atLeastOne", atLeastOne);
        req.addProperty("card", effectSource == null ? null : effectSource.getId());
        final JsonArray opts = new JsonArray();
        for (final Object k : keys) {
            final JsonObject o = k instanceof Byte b ? colorOption(b) : option(k, null);
            o.addProperty("max", target.get(k) == null ? amount : target.get(k));
            opts.add(o);
        }
        req.add("options", opts);
        final JsonElement answer = session.request("distribute", req);
        final Map<Object, Integer> out = new LinkedHashMap<>();
        if (answer != null && answer.isJsonArray() && answer.getAsJsonArray().size() == keys.size()) {
            for (int i = 0; i < keys.size(); i++) {
                out.put(keys.get(i), answer.getAsJsonArray().get(i).getAsInt());
            }
            return out;
        }
        // no answer (client gone): fall back to an even-handed split
        int remaining = amount;
        if (atLeastOne) {
            for (final Object t : keys) {
                if (remaining <= 0) { break; }
                out.put(t, 1);
                remaining--;
            }
        }
        out.merge(keys.get(0), remaining, Integer::sum);
        return out;
    }

    private static JsonObject colorOption(final byte color) {
        final JsonObject o = new JsonObject();
        o.addProperty("label", forge.card.MagicColor.toLongString(color));
        o.addProperty("color", forge.card.MagicColor.toShortString(color));
        return o;
    }

    @Override
    public void message(final String message, final String title) {
        notice("message", title == null ? message : title + ": " + message);
    }

    @Override
    public void showErrorDialog(final String message, final String title) {
        notice("error", message);
    }

    private boolean ask(final String message, final CardView card, final String yes, final String no) {
        final JsonObject req = new JsonObject();
        req.addProperty("message", message);
        req.addProperty("card", card == null ? null : card.getId());
        final JsonArray opts = new JsonArray();
        opts.add(yes);
        opts.add(no);
        req.add("buttons", opts);
        final JsonElement answer = session.request("confirm", req);
        return answer != null && answer.isJsonPrimitive() && answer.getAsInt() == 0;
    }

    @Override
    public boolean showConfirmDialog(final String message, final String title, final String yesButtonText, final String noButtonText, final boolean defaultYes) {
        return ask(message, null, yesButtonText, noButtonText);
    }

    @Override
    public boolean confirm(final CardView c, final String question, final boolean defaultIsYes, final List<String> options) {
        final String yes = options != null && !options.isEmpty() ? options.get(0) : "Yes";
        final String no = options != null && options.size() > 1 ? options.get(1) : "No";
        return ask(question, c, yes, no);
    }

    @Override
    public int showOptionDialog(final String message, final String title, final FSkinProp icon, final List<String> options, final int defaultOption) {
        final JsonObject req = new JsonObject();
        req.addProperty("message", message);
        final JsonArray opts = new JsonArray();
        options.forEach(opts::add);
        req.add("buttons", opts);
        final JsonElement answer = session.request("confirm", req);
        return answer != null && answer.isJsonPrimitive() ? answer.getAsInt() : defaultOption;
    }

    @Override
    public String showInputDialog(final String message, final String title, final FSkinProp icon, final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
        if (inputOptions != null && !inputOptions.isEmpty()) {
            final List<String> chosen = pick(message, 1, 1, inputOptions, null, null);
            return chosen.isEmpty() ? null : chosen.get(0);
        }
        final JsonObject req = new JsonObject();
        req.addProperty("message", message);
        req.addProperty("initial", initialInput);
        req.addProperty("numeric", isNumeric);
        final JsonElement answer = session.request("input", req);
        return answer == null || answer.isJsonNull() ? null : answer.getAsString();
    }

    @Override
    public List<PaperCard> sideboard(final CardPool sideboard, final CardPool main, final String message) {
        return new ArrayList<>(main.toFlatList());
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(final String title, final List<? extends GameEntityView> optionList, final DelayedReveal delayedReveal, final boolean isOptional) {
        if (optionList.isEmpty()) {
            return null;
        }
        if (!isOptional && optionList.size() == 1) {
            return optionList.get(0);
        }
        final List<GameEntityView> opts = new ArrayList<>(optionList);
        final List<GameEntityView> chosen = pick(title, isOptional ? 0 : 1, 1, opts, null, null);
        return chosen.isEmpty() ? null : chosen.get(0);
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(final String title, final List<? extends GameEntityView> optionList, final int min, final int max, final DelayedReveal delayedReveal) {
        return pick(title, min, max, new ArrayList<>(optionList), null, null);
    }

    @Override
    public List<CardView> manipulateCardList(final String title, final Iterable<CardView> cards, final Iterable<CardView> manipulable, final boolean toTop, final boolean toBottom, final boolean toAnywhere) {
        final List<CardView> list = new ArrayList<>();
        cards.forEach(list::add);
        return list;
    }
}

package tabletop.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.zone.ZoneType;
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
    /** the player this view belongs to */
    private final Client session;
    /** the seats this view plays, from openView (sent again when the player reconnects) */
    private volatile JsonArray myPlayers = new JsonArray();
    private final Object snapshotLock = new Object();
    private final Map<Integer, String> sentCards = new HashMap<>();
    private final List<JsonObject> pendingEvents = new ArrayList<>();

    private JsonObject prompt = new JsonObject();
    private int seq = 0;

    public SocketGuiGame(final Client session) {
        this.session = session;
        prompt.addProperty("message", "");
    }

    // ---- outbound state ----------------------------------------------------------------------

    /** Called on the game thread for every engine event, so the snapshot matches the moment it describes. */
    public void onGameEvent(final GameEvent event) {
        synchronized (snapshotLock) {
            final JsonObject json = Serializer.event(event);
            pendingEvents.add(json);
            // Forge reports each creature's damage separately; hold damage until the next other event so a
            // whole combat damage step (attackers and blockers striking at once), or a sweeper hitting every
            // creature, reaches the client together
            if (event instanceof GameEventCardDamaged || event instanceof GameEventPlayerDamaged) {
                holdingDamage = true;
                scheduleFallbackFlush();
                return;
            }
            // the bookkeeping Forge fires after each hit (stats changed, zones, priority) joins the held damage
            // instead of sending it one creature at a time
            if (holdingDamage && NOISE_EVENTS.contains(json.has("event") ? json.get("event").getAsString() : "")) {
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

    /** damage events are waiting to go out together (see onGameEvent) */
    private boolean holdingDamage;

    private void flushLocked() {
        holdingDamage = false;
        if (getGameView() == null) {
            return;
        }
        // Forge refreshes its combat view only between steps; attackers and blockers being declared right
        // now live on the game's Combat, so pull them into the view before every snapshot
        try {
            // (it changes the game's view objects: only on the game thread, never while the engine runs elsewhere)
            if (getGameView().getGame() != null && Serializer.onGameThread()) {
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
            // Forge's view can lag the move: after a mulligan the old hand's views still say Hand while the
            // cards sit in the library. A view claiming a zone that doesn't list the card is stale; ask the game.
            if (cv.getZone() != null && cv.getZone() != ZoneType.Library) {
                final Card real = getGameView().getGame() != null ? getGameView().getGame().findById(e.getKey()) : null;
                if (real != null && real.getZone() != null) {
                    json.addProperty("zone", real.getZone().getZoneType().name());
                }
            }
            final String text = json.toString();
            if (!text.equals(e.getValue())) {
                e.setValue(text);
                changed.add(key, json);
            }
        }
        state.add("cards", changed);

        final JsonObject promptOut = prompt.deepCopy();
        promptOut.add("source", resolvingSource());
        // always the input Forge holds right now, so the client can never be stuck answering an old one
        promptOut.addProperty("inputId", currentInputId());
        final JsonObject selection = Serializer.selection(getSelection());
        // abilities Forge's scan misses because their targets depend on X: highlight them as playable too
        if ("InputPassPriority".equals(currentInputName()) && getGameController() instanceof forge.player.PlayerControllerHuman pch) {
            try {
                final JsonArray actionable = selection.getAsJsonArray("actionable");
                for (final Integer id : BridgeHumanPlayer.readyCards(playerId())) {
                    if (!actionable.contains(new com.google.gson.JsonPrimitive(id))) {
                        actionable.add(id);
                    }
                }
            } catch (final RuntimeException ignored) {
                // mid-update; the next one says
            }
        }

        // Forge refreshes the view many times per step (priority passing between players, zone bookkeeping);
        // most refreshes change nothing the player can see. Skip those, or the client's queue backs up and
        // it has to rush its animations to catch up.
        boolean meaningful = changed.size() > 0;
        for (final JsonElement e : pendingEvents) {
            final String kind = e.isJsonObject() && e.getAsJsonObject().has("event") ? e.getAsJsonObject().get("event").getAsString() : "";
            if (!NOISE_EVENTS.contains(kind)) {
                meaningful = true;
                break;
            }
        }
        final String fingerprint = visibleFingerprint(state) + promptOut + selection;
        if (!meaningful && fingerprint.equals(lastFingerprint)) {
            pendingEvents.clear();
            return;
        }
        lastFingerprint = fingerprint;

        final JsonObject msg = new JsonObject();
        msg.addProperty("type", "update");
        msg.addProperty("seq", ++seq);
        final JsonArray events = new JsonArray();
        pendingEvents.forEach(events::add);
        pendingEvents.clear();
        msg.add("events", events);
        msg.add("state", state);
        msg.add("prompt", promptOut);
        msg.add("selection", selection);
        if (TRACE_INPUTS) System.out.println("[sent] prompt " + promptOut.get("inputId") + " " + promptOut.get("input") + " on " + Thread.currentThread().getName());
        session.send(msg);
    }

    /** Events the client draws nothing for; on their own they don't justify an update. */
    private static final java.util.Set<String> NOISE_EVENTS = java.util.Set.of(
            "Zone", "PlayerPriority", "AddLog", "ManaPool", "CardStatsChanged", "CombatUpdate", "TurnPhase");

    private String lastFingerprint = "";

    /** The state as the player sees it, minus whose priority it is (that changes on every pass). */
    private static String visibleFingerprint(final JsonObject state) {
        final JsonObject copy = state.deepCopy();
        if (copy.has("players")) {
            for (final JsonElement p : copy.getAsJsonArray("players")) {
                if (p.isJsonObject()) {
                    p.getAsJsonObject().remove("priority");
                }
            }
        }
        return copy.toString();
    }

    /** Why a land in hand can't be played right now, or null if it can (or isn't a land). */
    private String landPlayBlocked(final CardView view) {
        try {
            if (view == null || !view.getCurrentState().isLand()) {
                return null;
            }
            final forge.game.Game game = getGameView().getGame();
            final Card land = game == null ? null : game.findById(view.getId());
            if (land == null) {
                return null;
            }
            final forge.game.player.Player p = land.getController();
            if (!game.getPhaseHandler().isPlayerTurn(p)) {
                return "Lands can only be played on your own turn.";
            }
            if (p.getLandsPlayedThisTurn() >= p.getMaxLandPlays() && !p.getMaxLandPlaysInfinite()) {
                return "You've already played a land this turn.";
            }
            if (!p.canCastSorcery()) {
                return "Lands can only be played in a main phase while the stack is empty.";
            }
            return null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** A request to the player, tagged with the spell or ability that's asking (if one is resolving). */
    private JsonElement ask(final String kind, final JsonObject req) {
        req.add("source", resolvingSource());
        return session.request(kind, req);
    }

    /**
     * The spell or ability currently resolving, so prompts can say what is asking: a bare "Put Island on
     * top or bottom?" means little without "Preordain: Scry 2, then draw a card".
     */
    private JsonObject resolvingSource() {
        try {
            final forge.game.Game game = getGameView().getGame();
            if (game == null || !game.getStack().isResolving() || game.getStack().isEmpty()) {
                return null;
            }
            final forge.game.spellability.SpellAbility sa = game.getStack().peekAbility();
            if (sa == null) {
                return null;
            }
            final Card host = sa.getHostCard();
            final JsonObject o = new JsonObject();
            o.addProperty("card", host == null ? null : host.getId());
            o.addProperty("name", host == null ? null : host.getName());
            o.addProperty("text", game.getStack().peek().getStackDescription());
            o.addProperty("ability", !sa.isSpell());
            o.addProperty("trigger", sa.isTrigger());
            o.addProperty("controller", sa.getActivatingPlayer() == null ? null : sa.getActivatingPlayer().getId());
            return o;
        } catch (RuntimeException e) {
            return null; // the stack is changing under us; the prompt just goes without a source
        }
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
        try { liveGame = getGameView().getGame(); } catch (final RuntimeException ignored) { }
        final JsonArray you = new JsonArray();
        myPlayers.forEach(p -> you.add(p.getId()));
        this.myPlayers = you;
        sendGameStarted();
        flush();
    }

    private void sendGameStarted() {
        final JsonObject msg = new JsonObject();
        msg.addProperty("type", "gameStarted");
        msg.add("you", myPlayers.deepCopy());
        session.send(msg);
    }

    /** The player reconnected: their seat again, then the whole table (not just what changed). */
    void resend() {
        if (getGameView() == null) return;
        synchronized (snapshotLock) {
            sentCards.clear();
            lastFingerprint = null;
        }
        sendGameStarted();
        flush();
    }

    /** The id of the seat this view plays, or -1. */
    int playerId() {
        return myPlayers.size() > 0 ? myPlayers.get(0).getAsInt() : -1;
    }

    @Override public void showCombat() { flush(); }
    @Override public void updatePhase(final boolean saveState) { flush(); }
    @Override public void updateTurn(final PlayerView player) { flush(); }
    @Override public void updateStack() { flush(); }
    // view refreshes Forge makes after each hit wait while damage is being gathered (see onGameEvent);
    // the snapshot is taken when it goes out, so nothing is lost
    @Override public void updateZones(final Iterable<PlayerZoneUpdate> zonesToUpdate) { flushUnlessGatheringDamage(); }
    @Override public void updateCards(final Iterable<CardView> cards) { flushUnlessGatheringDamage(); }
    @Override public void updateManaPool(final Iterable<PlayerView> manaPoolUpdate) { flushUnlessGatheringDamage(); }
    @Override public void updateLives(final Iterable<PlayerView> livesUpdate) { flushUnlessGatheringDamage(); }

    private void flushUnlessGatheringDamage() {
        synchronized (snapshotLock) {
            if (!holdingDamage) {
                flushLocked();
            }
        }
    }
    @Override public void refreshField() { flush(); }

    @Override
    public void setSelection(final Selection selection) {
        super.setSelection(selection);
        flush();
    }

    @Override
    public void showPromptMessage(final PlayerView playerView, final String message, final CardView card) {
        // Forge puts up "Waiting for <opponent>…" 250 ms after an input ends. When this player's next input (paying
        // for the spell they just cast) is already showing, that late message would cover it and switch its buttons
        // off, leaving the game waiting on a prompt the player can no longer see. Keep the live input's prompt.
        if (isAwaitPrompt(message) && getGameController() instanceof forge.player.PlayerControllerHuman pch
                && pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputBase live) {
            forge.gui.FThreads.invokeInEdtLater(live::showMessageInitial);
            return;
        }
        final JsonObject lifePay = lifePayment();
        synchronized (snapshotLock) {
            prompt.addProperty("message", message == null ? "" : message);
            prompt.addProperty("card", card == null ? null : card.getId());
            putLifePay(lifePay);
        }
        flush();
    }

    private void putLifePay(final JsonObject lifePay) {
        if (lifePay != null) {
            prompt.add("lifePay", lifePay);
        } else {
            prompt.remove("lifePay");
        }
    }

    /**
     * While a cost is being paid: the parts of it that life can pay instead of mana (Phyrexian symbols, and
     * {B} under K'rrik's "pay 2 life rather than that mana"), so the client can offer a Pay 2 life button
     * instead of Forge's "click your life total". Read on the thread that's showing the payment prompt,
     * straight after Forge builds the same message from the same fields; nothing is evaluated.
     * Null when there's no such payment.
     */
    private JsonObject lifePayment() {
        if (!(getGameController() instanceof forge.player.PlayerControllerHuman pch)
                || !(pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputPayManaOfCostPayment pay)) {
            return null;
        }
        try {
            final Class<?> base = forge.gamemodes.match.input.InputPayMana.class;
            final java.lang.reflect.Field costF = base.getDeclaredField("manaCost");
            final java.lang.reflect.Field playerF = base.getDeclaredField("player");
            final java.lang.reflect.Field lifeF = base.getDeclaredField("phyLifeToLose");
            costF.setAccessible(true);
            playerF.setAccessible(true);
            lifeF.setAccessible(true);
            final forge.game.mana.ManaCostBeingPaid cost = (forge.game.mana.ManaCostBeingPaid) costF.get(pay);
            final forge.game.player.Player payer = (forge.game.player.Player) playerF.get(pay);
            if (cost == null || payer == null) {
                return null;
            }
            final boolean blackByLife = payer.hasKeyword("PayLifeInsteadOf:B");
            int shards = 0;
            boolean onlyLife = true;
            for (final forge.card.mana.ManaCostShard shard : cost.getUnpaidShards()) {
                if (shard.isPhyrexian() || (blackByLife && shard == forge.card.mana.ManaCostShard.BLACK)) {
                    shards++;
                } else {
                    onlyLife = false;
                }
            }
            if (shards == 0) {
                return null;
            }
            final JsonObject o = new JsonObject();
            o.addProperty("shards", shards);
            o.addProperty("each", 2);
            // life already set aside for symbols paid this way (Forge takes it when the payment completes)
            o.addProperty("committed", lifeF.getInt(pay));
            o.addProperty("life", payer.getLife());
            // nothing but life-payable symbols left to pay
            o.addProperty("onlyLife", onlyLife);
            o.addProperty("player", payer.getId());
            return o;
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.out.println("[bridge] couldn't read the life payment: " + e);
            return null;
        }
    }

    @Override
    public void updateButtons(final PlayerView owner, final String label1, final String label2, final boolean enable1, final boolean enable2, final boolean focus1) {
        // kept in step with the buttons: the client reads "only life left, and Auto can't pay it" from the pair
        final JsonObject lifePay = lifePayment();
        synchronized (snapshotLock) {
            putLifePay(lifePay);
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
            prompt.addProperty("inputId", currentInputId());
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

    /** The Forge input last numbered, and its number: each new input object gets the next one. */
    private static final boolean TRACE_INPUTS = Boolean.getBoolean("bridge.traceInputs");
    private Object numberedInput;
    private int inputId;

    /**
     * A number for the input Forge is showing now. The client runs a beat behind Forge (it animates every
     * update in turn), so each click carries the number of the prompt the player was looking at; a click
     * meant for an earlier prompt must not land on a later one (a creature clicked during a cast would
     * otherwise be taken as the sacrifice the cost asks for next).
     */
    synchronized int currentInputId() {
        final Object input = getGameController() instanceof forge.player.PlayerControllerHuman pch ? pch.getInputQueue().getInput() : null;
        if (input != numberedInput) {
            numberedInput = input;
            inputId++;
            if (TRACE_INPUTS) System.out.println("[input] #" + inputId + " " + (input == null ? "null" : input.getClass().getSimpleName() + "@" + System.identityHashCode(input)) + " on " + Thread.currentThread().getName());
        }
        return inputId;
    }

    /**
     * Names of the sources Forge's Auto button would sacrifice for mana right now (Lotus Petal, a Treasure),
     * or an empty list. Forge works out that plan before it enables Auto, so it is known by the time the
     * client's auto-pay arrives, even when the client hasn't been sent the plan yet.
     */
    java.util.List<String> autoPaySacrifices() {
        final java.util.List<String> names = new java.util.ArrayList<>();
        if (!(getGameController() instanceof forge.player.PlayerControllerHuman pch)
                || !(pch.getInputQueue().getInput() instanceof forge.gamemodes.match.input.InputPayMana pay)) {
            return names;
        }
        try {
            final java.lang.reflect.Field f = forge.gamemodes.match.input.InputPayMana.class.getDeclaredField("autoPayManaSources");
            f.setAccessible(true);
            final Object sources = f.get(pay);
            if (sources instanceof Iterable<?> it) {
                for (final Object o : it) {
                    if (o instanceof Card c && Serializer.manaCostsSacrifice(c)) {
                        names.add(c.getName());
                    }
                }
            }
        } catch (final ReflectiveOperationException | RuntimeException e) {
            System.out.println("[bridge] couldn't read the auto-pay plan: " + e);
        }
        return names;
    }

    /** A click was dropped because Forge had already moved past the prompt it answered. */
    void staleClick() {
        notice("stale", null);
    }

    /** Tell the client something it should show the player (a toast). */
    void tell(final String text) {
        notice("message", text);
    }

    private static volatile String[] awaitTexts;

    /** Whether a prompt is Forge's "Waiting for <player>…" / "Waiting for opponent…" (in the current language). */
    private static boolean isAwaitPrompt(final String message) {
        if (message == null) return false;
        String[] t = awaitTexts;
        if (t == null) {
            final forge.util.Localizer loc = forge.util.Localizer.getInstance();
            final String forPlayer = loc.getMessage("lblWaitingForPlayer", "\u0001");
            final int cut = forPlayer.indexOf('\u0001');
            t = new String[] { cut > 0 ? forPlayer.substring(0, cut) : forPlayer, loc.getMessage("lblWaitingForOpponent") };
            awaitTexts = t;
        }
        for (final String s : t) {
            if (s.length() > 3 && message.contains(s)) return true;
        }
        return false;
    }

    /** The Forge input class showing now (InputPassPriority, InputAttack…), or null. */
    String currentInputSimpleName() {
        return currentInputName();
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
        try {
            final forge.game.GameOutcome o = getGameView().getGame().getOutcome();
            System.out.println("[bridge] game over: winner=" + getGameView().getWinningPlayerName() + " outcome=" + (o == null ? null : o.getWinCondition() + " " + o.getOutcomeStrings()));
        } catch (final RuntimeException e) {
            System.out.println("[bridge] game over (outcome unavailable: " + e + ")");
        }
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
            if (label == null) { label = spellLabel(sa); }
        } else if (item instanceof PlayerView p) {
            o.addProperty("player", p.getId());
            if (label == null) { label = p.getName(); }
        } else if (item instanceof GameEntityView e) {
            o.addProperty("entity", e.getId());
        }
        o.addProperty("label", label == null ? String.valueOf(item) : label);
        return o;
    }

    /** the running game, for looking up what a view stands for */
    static volatile forge.game.Game liveGame;

    /**
     * A spell offered more than one way (alternative costs, flash costs, kicker…) is labelled by how you'd
     * pay for it, so "Pay {2}{B}{B}" and "Sacrifice a nontoken black creature" read differently at a glance.
     */
    private static String spellLabel(final SpellAbilityView view) {
        final String desc = view.getDescription();
        // alternative costs are made on the fly (not on the card's list): read the reminder Forge appends,
        // "(You may sacrifice a nontoken black creature rather than pay this spell's mana cost.)"
        final java.util.regex.Matcher alt = java.util.regex.Pattern
                .compile("\\((?:You may )?([^()]*?) rather than pay[^)]*\\)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(desc == null ? "" : desc);
        if (alt.find()) {
            final String how = alt.group(1).trim();
            final String effect = desc.substring(0, alt.start()).trim();
            return Character.toUpperCase(how.charAt(0)) + how.substring(1) + " — " + effect;
        }
        try {
            final forge.game.Game game = liveGame;
            final CardView host = view.getHostCard();
            if (game == null || host == null) { return desc; }
            final Card card = game.findById(host.getId());
            if (card == null) { return desc; }
            for (final forge.game.spellability.SpellAbility sa : card.getAllSpellAbilities()) {
                if (sa.getId() != view.getId() || !sa.isSpell() || sa.getPayCosts() == null) { continue; }
                final forge.game.cost.Cost cost = sa.getPayCosts();
                String how = cost.toSimpleString();
                if (how == null || how.isBlank()) { how = "Free"; }
                else if (how.startsWith("{") || how.matches("^[0-9X].*")) { how = "Pay " + how; }
                // the effect, without the reminder of the alternative cost
                final String effect = desc.replaceAll("\\s*\\([^)]*rather than pay[^)]*\\)", "").trim();
                return how + " — " + effect;
            }
        } catch (final RuntimeException ignored) {
            // fall back to Forge's own description
        }
        return desc;
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
        for (final int i : indices(ask("choose", req))) {
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
            ask("reveal", req);
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
        // Forge can pre-place items: re-ordering triggers it has ordered before (same abilities again) comes
        // with every item already in destChoices and nothing left in sourceChoices. Offer them all, in the
        // order they were placed, or an empty answer would drop the triggers entirely
        final List<T> all = new ArrayList<>();
        if (destChoices != null) all.addAll(destChoices);
        if (sourceChoices != null) all.addAll(sourceChoices);
        req.add("options", options(all, null));
        final List<T> ordered = new ArrayList<>();
        for (final int i : indices(ask("order", req))) {
            if (i >= 0 && i < all.size() && !ordered.contains(all.get(i))) {
                ordered.add(all.get(i));
            }
        }
        if (remainingObjectsMax <= 0) {
            // everything has to be placed: whatever the answer left out keeps its offered order
            for (final T t : all) if (!ordered.contains(t)) ordered.add(t);
        }
        return new OrderResult<>(ordered, false);
    }

    @Override
    public SpellAbilityView getAbilityToPlay(final CardView hostCard, final List<SpellAbilityView> abilities, final ITriggerEvent triggerEvent) {
        if (abilities.isEmpty()) {
            return null;
        }
        if (abilities.size() == 1) {
            // A land that can't be played right now offers only its other ability (cycling, channel...);
            // say why instead of silently starting that. Only for a click: the engine also comes here with no
            // click and a single ability already decided on (every ability put on the stack passes through its
            // optional-costs step this way), and asking then let a bounce land's own "return a land you
            // control" trigger, right after the land was played, be answered No and dropped, so the bounce
            // land stayed for free
            final String blocked = triggerEvent == null ? null : landPlayBlocked(hostCard);
            final String only = abilities.get(0).getDescription();
            if (blocked != null && only != null && !only.startsWith("Play land")) {
                return ask(blocked + "\n\nUse " + only + " instead?", hostCard, "Yes", "No") ? abilities.get(0) : null;
            }
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
        final JsonElement answer = ask("distribute", req);
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
        final JsonElement answer = ask("confirm", req);
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
        final JsonElement answer = ask("confirm", req);
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
        final JsonElement answer = ask("input", req);
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

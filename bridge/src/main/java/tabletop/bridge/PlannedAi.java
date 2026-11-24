package tabletop.bridge;

import forge.LobbyPlayer;
import forge.ai.ComputerUtilCard;
import forge.ai.ComputerUtilCombat;
import forge.ai.ComputerUtilCost;
import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.cost.CostSacrifice;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.player.GamePlayerUtil;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * An AI opponent that follows a {@link Gameplan.Plan}: Forge's own AI, with the plan written onto its cards as
 * the hints Forge already reads (cast priority, evaluation, sacrifice/discard preference, main-phase-1 casting),
 * and a few decisions taken over where Forge's judgement would work against the plan:
 * <ul>
 *   <li>an engine card's optional trigger is always accepted when it can be paid (Sephiroth's "you may sacrifice
 *       another creature");</li>
 *   <li>a protected card stays out of attacks that would get it killed and out of blocks it wouldn't survive,
 *       unless the AI's life depends on the block;</li>
 *   <li>a protected card is never the one sacrificed or discarded while something else will do.</li>
 * </ul>
 */
public final class PlannedAi extends LobbyPlayerAi {
    private final Gameplan.Plan plan;

    private PlannedAi(final String name, final Gameplan.Plan plan) {
        super(name, null);
        this.plan = plan;
    }

    /** Like {@link GamePlayerUtil#createAiPlayer(String, int)} (same avatar and profile choice), following the plan. */
    public static PlannedAi create(final String name, final int seat, final Gameplan.Plan plan) {
        final LobbyPlayerAi base = (LobbyPlayerAi) GamePlayerUtil.createAiPlayer(name, seat);
        final PlannedAi ai = new PlannedAi(name, plan);
        ai.setAvatarIndex(base.getAvatarIndex());
        ai.setSleeveIndex(base.getSleeveIndex());
        // the plan's stance picks the matching stock profile; balanced keeps whatever Forge would have used
        ai.setAiProfile(switch (plan.stance()) {
            case "aggressive" -> "Reckless";
            case "defensive" -> "Cautious";
            default -> base.getAiProfile();
        });
        return ai;
    }

    /** An AI without a gameplan that can be held to deals made at the table (Tabletalk): Forge's own play otherwise. */
    static PlannedAi forTable(final String name, final int seat) {
        return create(name, seat, new Gameplan.Plan("", "balanced", false, List.of()));
    }

    @Override
    public Player createIngamePlayer(final Game game, final int id) {
        final Player ai = new Player(getName(), game, id);
        ai.setFirstController(new Controller(game, ai, this, plan));
        return ai;
    }

    static final class Controller extends PlayerControllerAi {
        private static final ZoneType[] ZONES = {
            ZoneType.Battlefield, ZoneType.Hand, ZoneType.Library, ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command,
        };
        /** at least this much extra evaluation for a protected creature, so costs that sacrifice "the worst" skip it */
        private static final int PROTECTED_VALUE = 150;

        private final Gameplan.Plan plan;
        private final Map<String, Gameplan.CardHint> hints = new HashMap<>();

        Controller(final Game game, final Player p, final LobbyPlayer lp, final Gameplan.Plan plan) {
            super(game, p, lp);
            this.plan = plan;
            for (final Gameplan.CardHint h : plan.cards()) hints.put(key(h.name()), h);
            holdToDeals(game, p);
        }

        /**
         * Deals made at the table (Tabletalk): a play aimed at a player this AI promised to leave alone is turned
         * down as the AI weighs it, so it picks something else. Forge keeps its decision maker in a private field.
         */
        private void holdToDeals(final Game game, final Player p) {
            try {
                final java.lang.reflect.Field f = PlayerControllerAi.class.getDeclaredField("brains");
                f.setAccessible(true);
                f.set(this, new forge.ai.AiController(p, game) {
                    @Override
                    public forge.ai.AiPlayDecision canPlaySa(final SpellAbility sa) {
                        final forge.ai.AiPlayDecision d = super.canPlaySa(sa);
                        return d == forge.ai.AiPlayDecision.WillPlay && TableTalk.forbidsTarget(player, sa) ? forge.ai.AiPlayDecision.AnotherTime : d;
                    }
                });
            } catch (final ReflectiveOperationException | RuntimeException e) {
                System.err.println("[tabletalk] promises about targets can't be held to: " + e);
            }
        }

        private static String key(final String name) {
            return name.trim().toLowerCase(Locale.ROOT);
        }

        /** The plan's word on a card, by its current name or its printed (front-face) name. */
        private Gameplan.CardHint hint(final Card c) {
            Gameplan.CardHint h = hints.get(key(c.getName()));
            if (h == null && c.getPaperCard() != null) h = hints.get(key(c.getPaperCard().getName()));
            return h;
        }

        private boolean isProtected(final Card c) {
            final Gameplan.CardHint h = hint(c);
            return h != null && h.protect();
        }

        private boolean isEngine(final Card c) {
            final Gameplan.CardHint h = hint(c);
            return h != null && h.engine();
        }

        // ---- the plan on the cards, kept current (new draws, tokens, transformed faces) ----------------

        private void refresh() {
            for (final ZoneType z : ZONES) {
                for (final Card c : player.getCardsIn(z)) apply(c);
            }
        }

        private void apply(final Card c) {
            final Gameplan.CardHint h = hint(c);
            if (h == null) {
                if (plan.tokensAreFodder() && c.isToken() && c.isCreature()) put(c, "SacMe", "3");
                return;
            }
            if (h.castPriority() != 0) put(c, "AIPriorityModifier", String.valueOf(h.castPriority()));
            final int value = h.protect() ? Math.max(h.value(), PROTECTED_VALUE) : h.value();
            if (value != 0) put(c, "AIEvaluationModifier", String.valueOf(value));
            if (h.sacrificeFodder() > 0 && !h.protect()) put(c, "SacMe", String.valueOf(h.sacrificeFodder()));
            if (h.discardFodder() > 0 && !h.protect()) put(c, "DiscardMe", String.valueOf(h.discardFodder()));
            if (h.castBeforeCombat()) put(c, "PlayMain1", "TRUE");
        }

        private static void put(final Card c, final String svar, final String value) {
            if (!value.equals(c.getSVar(svar))) c.setSVar(svar, value);
        }

        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            refresh();
            return super.chooseSpellAbilityToPlay();
        }

        // ---- engine triggers --------------------------------------------------------------------------

        @Override
        public boolean confirmTrigger(final WrappedAbility wrapper) {
            refresh();
            final boolean forge = super.confirmTrigger(wrapper);
            if (forge || wrapper.isMandatory()) return forge;
            final SpellAbility sa = wrapper.getWrappedAbility();
            final Card host = sa.getHostCard();
            // only untargeted triggers: a declined targeted one has had its targets cleared
            if (host == null || !isEngine(host) || sa.usesTargeting()) return false;
            if (!ComputerUtilCost.canPayCost(sa, player, false)) return false;
            // a sacrifice cost needs something other than the plan's key pieces to give up
            if (sa.getPayCosts() != null && sa.getPayCosts().hasSpecificCostType(CostSacrifice.class)) {
                final boolean fodder = player.getCreaturesInPlay().stream().anyMatch(c -> c != host && !isProtected(c));
                if (!fodder) return false;
            }
            log("" + player.getName() + " takes " + host.getName() + "'s optional trigger");
            return true;
        }

        // ---- keeping key pieces alive -----------------------------------------------------------------

        @Override
        public void declareAttackers(final Player attacker, final Combat combat) {
            refresh();
            super.declareAttackers(attacker, combat);
            keepAttackDeals(combat);
            for (final Card c : new ArrayList<>(combat.getAttackers())) {
                if (!isProtected(c)) continue;
                final GameEntity def = combat.getDefenderByAttacker(c);
                final Player defender = def instanceof Player p ? p : def instanceof Card card ? card.getController() : null;
                if (defender != null && ComputerUtilCard.canBeBlockedProfitably(defender, c, true)) {
                    combat.removeFromCombat(c);
                    log("" + player.getName() + " keeps " + c.getName() + " home (it would die attacking)");
                }
            }
        }

        /**
         * Attackers sent at somebody this AI promised not to attack go at another opponent instead, when that isn't
         * throwing them away, or stay home; with a promise to attack somebody, the attack goes there. A creature
         * that has to attack keeps to the rules before the deal.
         */
        private void keepAttackDeals(final Combat combat) {
            final Player urged = TableTalk.urgedAt(player);
            boolean changed = false;
            final java.util.Map<Card, GameEntity> before = new java.util.LinkedHashMap<>();
            for (final Card c : combat.getAttackers()) before.put(c, combat.getDefenderByAttacker(c));
            for (final java.util.Map.Entry<Card, GameEntity> e : before.entrySet()) {
                final Card c = e.getKey();
                final GameEntity def = e.getValue();
                final Player at = def instanceof Player p ? p : def instanceof Card card ? card.getController() : null;
                Player to = null;
                final boolean forbidden = TableTalk.forbidsAttack(player, at);
                if (urged != null && at != urged && forge.game.combat.CombatUtil.canAttack(c, urged)) {
                    to = urged;
                } else if (forbidden) {
                    for (final Player p : player.getOpponents()) {
                        if (p != at && !p.hasLost() && !TableTalk.forbidsAttack(player, p) && forge.game.combat.CombatUtil.canAttack(c, p)
                                && !ComputerUtilCard.canBeBlockedProfitably(p, c, true)) {
                            to = p;
                            break;
                        }
                    }
                } else {
                    continue;
                }
                if (to == null && !forbidden) continue;
                combat.removeFromCombat(c);
                if (to != null) combat.addAttacker(c, to);
                changed = true;
                log(player.getName() + (to != null ? " sends " + c.getName() + " at " + to.getName() : " keeps " + c.getName() + " home") + " (deal)");
            }
            if (urged != null && combat.getAttackersOf(urged).isEmpty()) {
                for (final Card c : player.getCreaturesInPlay()) {
                    if (!combat.isAttacking(c) && !isProtected(c) && forge.game.combat.CombatUtil.canAttack(c, urged) && !ComputerUtilCard.canBeBlockedProfitably(urged, c, true)) {
                        combat.addAttacker(c, urged);
                        changed = true;
                        log(player.getName() + " sends " + c.getName() + " at " + urged.getName() + " (deal)");
                    }
                }
            }
            if (changed && !forge.game.combat.CombatUtil.validateAttackers(combat)) {
                // not a legal attack (something must attack): Forge's own stands
                for (final Card c : new ArrayList<>(combat.getAttackers())) combat.removeFromCombat(c);
                before.forEach(combat::addAttacker);
                log(player.getName() + " has to attack as it was (deal set aside)");
            }
        }

        @Override
        public void declareBlockers(final Player defender, final Combat combat) {
            refresh();
            super.declareBlockers(defender, combat);
            if (defender != player) return;
            for (final Card blocker : new ArrayList<>(combat.getAllBlockers())) {
                if (blocker.getController() != player || !isProtected(blocker)) continue;
                if (!ComputerUtilCombat.blockerWouldBeDestroyed(player, blocker, combat)) continue;
                final List<Card> blocked = new ArrayList<>(combat.getAttackersBlockedBy(blocker));
                combat.removeFromCombat(blocker);
                if (ComputerUtilCombat.lifeInSeriousDanger(player, combat)) {
                    // the block is what keeps the AI alive: it stays
                    for (final Card a : blocked) combat.addBlocker(a, blocker);
                } else {
                    log("" + player.getName() + " won't throw " + blocker.getName() + " in front of " + blocked);
                }
            }
        }

        @Override
        public CardCollectionView choosePermanentsToSacrifice(final SpellAbility sa, final int min, final int max, final CardCollectionView validTargets, final String message) {
            refresh();
            final CardCollectionView chosen = super.choosePermanentsToSacrifice(sa, min, max, validTargets, message);
            if (chosen == null || chosen.stream().noneMatch(this::isProtected)) return chosen;
            // the same number of cards, key pieces last: fodder first, then tokens, then the least valuable
            final List<Card> order = new ArrayList<>(validTargets.size());
            validTargets.forEach(order::add);
            order.sort(Comparator.<Card>comparingInt(c -> isProtected(c) ? 1 : 0)
                    .thenComparingInt(c -> -sacMe(c))
                    .thenComparingInt(c -> c.isToken() ? 0 : 1)
                    .thenComparingInt(c -> c.isCreature() ? ComputerUtilCard.evaluateCreature(c) : c.getCMC() * 30));
            final CardCollection out = new CardCollection();
            for (int i = 0; i < Math.max(min, chosen.size()) && i < order.size(); i++) out.add(order.get(i));
            return out;
        }

        @Override
        public CardCollection chooseCardsToDiscardFrom(final Player p, final SpellAbility sa, final CardCollection validCards, final int min, final int max, final CardCollectionView visibleToChooser) {
            refresh();
            final CardCollection chosen = super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
            if (p != player || chosen == null || chosen.stream().noneMatch(this::isProtected)) return chosen;
            final List<Card> order = new ArrayList<>(validCards);
            order.sort(Comparator.<Card>comparingInt(c -> isProtected(c) ? 1 : 0)
                    .thenComparingInt(c -> chosen.contains(c) ? 0 : 1)
                    .thenComparingInt(c -> -discardMe(c))
                    .thenComparingInt(Card::getCMC));
            final CardCollection out = new CardCollection();
            for (int i = 0; i < chosen.size() && i < order.size(); i++) out.add(order.get(i));
            return out;
        }

        /** Plan decisions go in the bridge's log, but not from the AI's look-ahead copies of the game. */
        private void log(final String line) {
            if (!player.getGame().isSimulationCopy()) System.out.println("[plan] " + line);
        }

        private static int sacMe(final Card c) {
            return intSVar(c, "SacMe");
        }

        private static int discardMe(final Card c) {
            return intSVar(c, "DiscardMe");
        }

        private static int intSVar(final Card c, final String name) {
            if (!c.hasSVar(name)) return 0;
            try {
                return Integer.parseInt(c.getSVar(name).trim());
            } catch (final NumberFormatException e) {
                return 0;
            }
        }
    }
}

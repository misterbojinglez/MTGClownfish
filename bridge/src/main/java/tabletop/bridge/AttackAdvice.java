package tabletop.bridge;

import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.combat.AttackConstraints;
import forge.game.combat.AttackRequirement;
import forge.game.combat.AttackRestriction;
import forge.game.combat.AttackRestrictionType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import org.apache.commons.lang3.tuple.Pair;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Why an attack isn't legal, in words, and (when something has to be added or re-aimed) the change that makes it so. Game thread only. */
final class AttackAdvice {

    /** What's wrong, one reason a line. */
    final String message;
    /** Creatures to send, and at whom, to make the attack legal; empty when there's no single obvious fix. */
    final Map<Card, GameEntity> fix;
    /** The fix as a button. */
    final String button;

    private AttackAdvice(final String message, final Map<Card, GameEntity> fix, final String button) {
        this.message = message;
        this.fix = fix;
        this.button = button;
    }

    /** Creatures that must attack, each with the defenders that would satisfy it (empty: any of them). */
    static Map<Card, List<GameEntity>> mustAttack(final Combat combat) {
        final Map<Card, List<GameEntity>> out = new LinkedHashMap<>();
        final AttackConstraints constraints = combat.getAttackConstraints();
        for (final Map.Entry<Card, AttackRequirement> e : constraints.getRequirements().entrySet()) {
            final AttackRestriction restriction = constraints.getRestrictions().get(e.getKey());
            final List<GameEntity> open = new ArrayList<>();
            final List<GameEntity> wanted = new ArrayList<>();
            int most = 0;
            for (final Pair<GameEntity, Integer> r : e.getValue().getSortedRequirements()) {
                // a creature never has to pay to attack
                if (!combat.getDefenders().contains(r.getLeft()) || !restriction.canAttack(r.getLeft())
                        || CombatUtil.getAttackCost(e.getKey().getGame(), e.getKey(), r.getLeft()) != null) {
                    continue;
                }
                open.add(r.getLeft());
                if (r.getRight() > most) {
                    most = r.getRight();
                    wanted.clear();
                }
                if (r.getRight() == most) {
                    wanted.add(r.getLeft());
                }
            }
            if (most > 0) {
                out.put(e.getKey(), wanted.size() == open.size() ? List.of() : wanted);
            }
        }
        return out;
    }

    static AttackAdvice of(final Combat combat) {
        final AttackConstraints constraints = combat.getAttackConstraints();
        final Map<Card, GameEntity> attack = new LinkedHashMap<>(combat.getAttackersAndDefenders());
        final Set<String> reasons = new LinkedHashSet<>();
        int now = constraints.countViolations(attack);

        if (now == -1) {
            attack.forEach((c, defender) -> {
                final AttackRestriction r = constraints.getRestrictions().get(c);
                if (r == null) {
                    return;
                }
                if (!r.canAttack(defender)) {
                    reasons.add(c.getName() + " can't attack " + defender + ".");
                }
                for (final AttackRestrictionType t : r.getViolation(attack)) {
                    reasons.add(c.getName() + switch (t) {
                        case ONLY_ALONE -> " can only attack alone.";
                        case NEED_GREATER_POWER -> " can't attack unless a creature with greater power also attacks.";
                        case NEED_BLACK_OR_GREEN -> " can't attack unless another creature that's black or green also attacks.";
                        case NOT_ALONE -> " can't attack alone.";
                        case NEED_TWO_OTHERS -> " can't attack unless at least two other creatures attack.";
                        case NEVER -> " can't attack.";
                    });
                }
            });
            final Integer max = constraints.getGlobalRestrictions().getMax();
            if (max != null && attack.size() > max) {
                reasons.add("No more than " + creatures(max) + " can attack this combat.");
            }
            constraints.getGlobalRestrictions().getDefenderMax().forEach((defender, most) -> {
                if (attack.values().stream().filter(defender::equals).count() > most) {
                    reasons.add(most == 0 ? "No creatures can attack " + defender + "."
                            : "No more than " + creatures(most) + " can attack " + defender + " this combat.");
                }
            });
            return new AttackAdvice(text(reasons), Map.of(), null);
        }

        // Something that has to attack isn't. Change one creature at a time, keeping everything else the player
        // chose, until the attack breaks no more requirements than the best legal one.
        final int best = constraints.getLegalAttackers().getRight();
        final Map<Card, List<GameEntity>> must = mustAttack(combat);
        final Map<Card, GameEntity> fix = new LinkedHashMap<>();
        boolean moved = false;
        while (now > best) {
            Card who = null;
            GameEntity at = null;
            int least = now;
            long company = -1;
            for (final Card c : constraints.getRequirements().keySet()) {
                for (final GameEntity defender : combat.getDefenders()) {
                    if (defender.equals(attack.get(c)) || CombatUtil.getAttackCost(c.getGame(), c, defender) != null) {
                        continue;
                    }
                    final Map<Card, GameEntity> tried = new HashMap<>(attack);
                    tried.put(c, defender);
                    final int violations = constraints.countViolations(tried);
                    // on a tie, along with the rest of the attack
                    final long with = attack.values().stream().filter(defender::equals).count();
                    if (violations >= 0 && (violations < least || (violations == least && who != null && with > company))) {
                        who = c;
                        at = defender;
                        least = violations;
                        company = with;
                    }
                }
            }
            if (who == null) {
                break;
            }
            final List<GameEntity> wanted = must.get(who);
            if (wanted == null) {
                reasons.add("An effect makes you attack " + at + " if able.");
            } else {
                reasons.add(who.getName() + (who.isGoaded() ? " is goaded: it must attack" : " must attack")
                        + (wanted.isEmpty() ? " this combat if able." : " " + names(wanted) + " if able."));
            }
            moved |= combat.isAttacking(who);
            attack.put(who, at);
            fix.put(who, at);
            now = least;
        }
        if (now > best) { // no such change gets there (a limit on attackers, say): name what's left out
            must.forEach((c, wanted) -> {
                if (!combat.isAttacking(c)) {
                    reasons.add(c.getName() + " must attack" + (wanted.isEmpty() ? " this combat" : " " + names(wanted)) + " if able.");
                }
            });
            return new AttackAdvice(text(reasons), Map.of(), null);
        }
        final String who = fix.size() == 1 ? fix.keySet().iterator().next().getName() : fix.size() + " creatures";
        final String button = moved ? (fix.size() == 1 ? "Send " + who + " at " + fix.values().iterator().next() : "Fix the attack") : "Add " + who;
        return new AttackAdvice(text(reasons), fix, button);
    }

    static String names(final List<GameEntity> defenders) {
        return String.join(" or ", defenders.stream().map(GameEntity::getName).toList());
    }

    private static String creatures(final int n) {
        return n == 1 ? "one creature" : n + " creatures";
    }

    private static String text(final Set<String> reasons) {
        return reasons.isEmpty() ? "That attack isn't allowed by the effects in play." : String.join("\n", reasons);
    }
}

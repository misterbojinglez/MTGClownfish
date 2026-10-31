package tabletop.bridge;

import forge.game.Game;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetRestrictions;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;

import java.util.ArrayList;
import java.util.List;

/**
 * The human seat, with one addition to Forge's controller: when a triggered ability of yours can't go on
 * the stack because it has no legal target (Phyrexian Delver entering with no creature card in your
 * graveyard), Forge drops it silently. Rule 603.3d, but easy to miss, so the player is told.
 */
final class BridgeHumanPlayer extends LobbyPlayerHuman {

    BridgeHumanPlayer(final String name) {
        super(name);
    }

    @Override
    public Player createIngamePlayer(final Game game, final int id) {
        final Player player = new Player(forge.util.GuiDisplayUtil.personalizeHuman(getName()), game, id);
        player.setFirstController(new Controller(game, player, this));
        return player;
    }

    private static final class Controller extends PlayerControllerHuman {
        Controller(final Game game, final Player player, final LobbyPlayerHuman lobby) {
            super(game, player, lobby);
        }

        @Override
        public void orderAndPlaySimultaneousSa(final List<SpellAbility> activePlayerSAs) {
            // targets are chosen as each trigger goes on the stack; note which ones need one
            final List<SpellAbility> targeted = new ArrayList<>();
            for (final SpellAbility sa : activePlayerSAs) {
                if (sa.isTrigger() && !sa.isCopied() && sa.usesTargeting()) {
                    targeted.add(sa);
                }
            }
            super.orderAndPlaySimultaneousSa(activePlayerSAs);
            for (final SpellAbility sa : targeted) {
                try {
                    if (getGame().getStack().getInstanceMatchingSpellAbilityID(sa) != null || !lacksTargets(sa)) {
                        continue;
                    }
                    final String name = sa.getHostCard() == null ? "A" : sa.getHostCard().getName() + "'s";
                    if (getGui() instanceof SocketGuiGame gui) {
                        gui.tell(name + " trigger had no legal target, so it didn't go on the stack.");
                    }
                } catch (final RuntimeException ignored) {
                    // the game moved on; nothing worth reporting
                }
            }
        }

        /** Too few legal targets for this ability right now. */
        private static boolean lacksTargets(final SpellAbility sa) {
            final TargetRestrictions tgt = sa.getTargetRestrictions();
            if (tgt == null) {
                return false;
            }
            return tgt.getAllCandidates(sa).size() < tgt.getMinTargets(sa.getHostCard(), sa);
        }
    }
}

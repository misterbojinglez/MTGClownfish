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

        /**
         * Forge's "pass when there's nothing to do" ignores mana abilities, so a main phase whose only option
         * is a sacrifice outlet that makes mana (Soldevi Adnate, Ashnod's Altar) was passed straight through.
         * Sacrificing something is a real decision, so in your own main phase with an empty stack, when such an
         * ability is usable, auto-pass is held for this priority.
         */
        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            final boolean hold = sacrificeOutletReady() || libraryTopPlayable();
            final forge.gamemodes.match.YieldController yc = getYieldController();
            if (hold) {
                yc.setPref(forge.localinstance.properties.ForgePreferences.FPref.YIELD_AUTO_PASS_NO_ACTIONS, "false");
            }
            try {
                return super.chooseSpellAbilityToPlay();
            } finally {
                if (hold) {
                    yc.setPref(forge.localinstance.properties.ForgePreferences.FPref.YIELD_AUTO_PASS_NO_ACTIONS, "true");
                }
            }
        }

        /**
         * The top of your library is a card you may play right now (Bolas's Citadel, Future Sight): Forge's
         * pass-when-nothing-to-do never looks in the library, so it would pass right by it.
         */
        private boolean libraryTopPlayable() {
            try {
                final Player me = getPlayer();
                final forge.game.zone.PlayerZone lib = me.getZone(forge.game.zone.ZoneType.Library);
                if (lib == null || lib.isEmpty()) {
                    return false;
                }
                final forge.game.card.Card top = lib.get(0);
                return top.getView().canBeShownTo(me.getView()) && Serializer.playableNow(top, me);
            } catch (final RuntimeException ignored) {
                return false;
            }
        }

        /** Your main phase, nothing on the stack, and a mana ability you could use that sacrifices another permanent. */
        private boolean sacrificeOutletReady() {
            try {
                final Game game = getGame();
                final Player me = getPlayer();
                if (!game.getPhaseHandler().isPlayerTurn(me) || !game.getPhaseHandler().getPhase().isMain() || !game.getStack().isEmpty()) {
                    return false;
                }
                for (final forge.game.card.Card c : me.getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                    for (final SpellAbility ma : c.getManaAbilities()) {
                        if (ma.getPayCosts() == null) {
                            continue;
                        }
                        boolean sacrificesOther = false;
                        for (final forge.game.cost.CostPart part : ma.getPayCosts().getCostParts()) {
                            if (part instanceof forge.game.cost.CostSacrifice && !part.payCostFromSource()) {
                                sacrificesOther = true;
                            }
                        }
                        if (!sacrificesOther) {
                            continue;
                        }
                        ma.setActivatingPlayer(me);
                        if (ma.canPlay() && forge.game.cost.CostPayment.canPayAdditionalCosts(ma.getPayCosts(), ma, false)) {
                            return true;
                        }
                    }
                }
            } catch (final RuntimeException ignored) {
                // mid-update; fall back to Forge's own judgement
            }
            return false;
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

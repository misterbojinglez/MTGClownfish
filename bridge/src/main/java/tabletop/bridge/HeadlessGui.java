package tabletop.bridge;

import forge.gamemodes.match.HostedMatch;
import forge.gui.download.GuiDownloadService;
import forge.gui.interfaces.IGuiBase;
import forge.gui.interfaces.IGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.localinstance.skin.ISkinImage;
import forge.sound.IAudioClip;
import forge.sound.IAudioMusic;
import forge.util.FSerializableFunction;
import forge.util.ImageFetcher;
import org.jupnp.UpnpServiceConfiguration;

import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * Forge's platform layer with no screen. Forge routes "UI thread" work through here, so a single
 * executor stands in for the Swing EDT; card art and audio are the client's business, not Forge's.
 */
public class HeadlessGui implements IGuiBase {
    private final String assetsDir;
    private volatile Thread edtThread;
    private final ExecutorService edt = Executors.newSingleThreadExecutor(r -> {
        final Thread t = new Thread(r, "bridge-edt");
        t.setDaemon(true);
        edtThread = t;
        return t;
    });

    public HeadlessGui(final String assetsDir) {
        this.assetsDir = assetsDir.endsWith("/") ? assetsDir : assetsDir + "/";
    }

    @Override public boolean isRunningOnDesktop() { return true; }
    @Override public boolean isLibgdxPort() { return false; }
    @Override public String getCurrentVersion() { return "tabletop-bridge"; }
    @Override public String getUserAgent() { return "tabletop-bridge"; }

    @Override public void invokeInEdtNow(final Runnable runnable) { runnable.run(); }
    @Override public void invokeInEdtLater(final Runnable runnable) { edt.execute(runnable); }

    @Override
    public void invokeInEdtAndWait(final Runnable proc) {
        if (isGuiThread()) {
            proc.run();
            return;
        }
        try {
            edt.submit(proc).get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException e) {
            throw new RuntimeException(e.getCause());
        }
    }

    @Override public void runBackgroundTask(final String message, final Runnable task) { new Thread(task, "bridge-bg").start(); }
    @Override public boolean isGuiThread() { return Thread.currentThread() == edtThread; }
    @Override public String getAssetsDir() { return assetsDir; }
    @Override public ImageFetcher getImageFetcher() { return null; }
    @Override public ISkinImage getSkinIcon(final FSkinProp skinProp) { return null; }
    @Override public ISkinImage getUnskinnedIcon(final String path) { return null; }
    @Override public ISkinImage getCardArt(final PaperCard card, final boolean backFace) { return null; }
    @Override public ISkinImage createLayeredImage(final PaperCard card, final FSkinProp background, final String overlayFilename, final float opacity) { return null; }
    @Override public void clearImageCache() { }
    @Override public String encodeSymbols(final String str, final boolean formatReminderText) { return str; }
    @Override public int getAvatarCount() { return 0; }
    @Override public int getSleevesCount() { return 0; }
    @Override public float getScreenScale() { return 1f; }
    @Override public void preventSystemSleep(final boolean preventSleep) { }
    @Override public void download(final GuiDownloadService service, final Consumer<Boolean> callback) { callback.accept(false); }
    @Override public void copyToClipboard(final String text) { }
    @Override public void browseToUrl(final String url) { }
    @Override public void showCardList(final String title, final String message, final List<PaperCard> list) { }
    @Override public boolean showBoxedProduct(final String title, final String message, final List<PaperCard> list) { return false; }
    @Override public void showBugReportDialog(final String title, final String text, final boolean showExitAppBtn) { System.err.println("[forge] " + title + "\n" + text); }
    @Override public void showImageDialog(final ISkinImage image, final String message, final String title) { }
    @Override public int showOptionDialog(final String message, final String title, final FSkinProp icon, final List<String> options, final int defaultOption) { return defaultOption; }

    @Override
    public String showInputDialog(final String message, final String title, final FSkinProp icon, final String initialInput, final List<String> inputOptions, final boolean isNumeric) {
        return initialInput;
    }

    @Override public String showFileDialog(final String title, final String defaultDir) { return null; }
    @Override public File getSaveFile(final File defaultFile) { return defaultFile; }

    @Override
    public <T> List<T> order(final String title, final String top, final int remainingObjectsMin, final int remainingObjectsMax, final List<T> sourceChoices, final List<T> destChoices) {
        return new ArrayList<>(sourceChoices);
    }

    @Override
    public <T> List<T> getChoices(final String message, final int min, final int max, final Collection<T> choices, final Collection<T> selected, final FSerializableFunction<T, String> display) {
        return new ArrayList<>(choices).subList(0, Math.min(min, choices.size()));
    }

    @Override public PaperCard chooseCard(final String title, final String message, final List<PaperCard> list) { return list.isEmpty() ? null : list.get(0); }
    @Override public boolean isSupportedAudioFormat(final File file) { return false; }
    @Override public IAudioClip createAudioClip(final String filename) { return null; }
    @Override public IAudioMusic createAudioMusic(final String filename) { return null; }
    @Override public void startAltSoundSystem(final String filename, final boolean isSynchronized) { }
    @Override public void showSpellShop() { }
    @Override public void showBazaar() { }
    @Override public IGuiGame getNewGuiGame() { throw new UnsupportedOperationException("the bridge creates its own GUI"); }
    @Override public HostedMatch hostMatch() { return new HostedMatch(); }
    @Override public UpnpServiceConfiguration getUpnpPlatformService() { return null; }
    @Override public boolean hasNetGame() { return false; }
}

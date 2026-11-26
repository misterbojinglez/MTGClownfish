// Fullscreen, for the Settings dialog. In the desktop app the window itself goes fullscreen (and the app
// remembers it for the next launch); in a browser, the page asks for fullscreen, which lasts until Escape.

interface DesktopApi {
  setFullScreen(on: boolean): void;
  isFullScreen(): Promise<boolean>;
  onFullScreen(fn: (on: boolean) => void): void;
}

const desktop = (window as unknown as { desktop?: DesktopApi }).desktop;

export const fullscreenSupported = !!desktop || !!document.fullscreenEnabled;

const listeners = new Set<(on: boolean) => void>();
const tell = (on: boolean) => listeners.forEach((fn) => fn(on));
if (desktop) desktop.onFullScreen(tell);
else document.addEventListener('fullscreenchange', () => tell(!!document.fullscreenElement));

export function isFullscreen(): Promise<boolean> {
  return desktop ? desktop.isFullScreen() : Promise.resolve(!!document.fullscreenElement);
}

export function setFullscreen(on: boolean): void {
  if (desktop) desktop.setFullScreen(on);
  else if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/** Calls fn whenever fullscreen starts or ends (however it did); returns an unsubscribe. */
export function onFullscreen(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

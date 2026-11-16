/**
 * Which page may drive the privileged integration handlers.
 *
 * Electron hands every IPC handler the frame the call came from. These handlers
 * change what agents can reach (grants, the sign-in engine, tool discovery), so they
 * answer only the app's own top-level page: the packaged `index.html`, or the dev
 * server's origin in development. A sub-frame, a page the window navigated to, or a
 * frame whose URL cannot be read is refused.
 *
 * This is defence in depth, not a boundary on its own: the renderer is the app's own
 * code and these handlers are also validated field by field. Electron-free.
 */
export interface FrameLike { url?: unknown; parent?: unknown }

export interface TrustedPages {
  /** Development: the renderer dev server's origin (`ELECTRON_RENDERER_URL`). */
  devOrigin?: string;
  /** Packaged: the file URL of the renderer's `index.html`. */
  prodFileUrl?: string;
}

export function isTrustedSender(frame: FrameLike | null | undefined, pages: TrustedPages): boolean {
  if (!frame || typeof frame.url !== 'string') return false;
  if (frame.parent !== null) return false;                       // only the top-level frame
  let url: URL;
  try { url = new URL(frame.url); } catch { return false; }
  if (pages.devOrigin) {
    try { return url.origin === new URL(pages.devOrigin).origin && url.protocol !== 'file:'; } catch { return false; }
  }
  if (pages.prodFileUrl) {
    try {
      const page = new URL(pages.prodFileUrl);
      return url.protocol === 'file:' && page.protocol === 'file:' && url.host === page.host && url.pathname === page.pathname;
    } catch { return false; }
  }
  return false;
}

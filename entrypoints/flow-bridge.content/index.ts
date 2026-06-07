/**
 * ISOLATED-world content script — runs on labs.google/fx/tools/flow.
 *
 * 1. Injects `flow-bridge-main.js` into the page's MAIN world so it can
 *    access `window.grecaptcha.enterprise` and patch `window.fetch`.
 * 2. Bridges messages between the background service worker and the
 *    injected MAIN-world script using `window` CustomEvents.
 * 3. Forwards TRPC media URL payloads to the background.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { injectScript } from 'wxt/utils/inject-script';

interface CaptchaRequestMessage {
  type: 'GET_CAPTCHA';
  requestId: string;
  pageAction: string;
}

interface TrpcMediaEventDetail {
  url: string;
  body: string;
}

const CAPTCHA_TIMEOUT_MS = 25_000;

export default defineContentScript({
  matches: [
    'https://labs.google/fx/tools/flow*',
    'https://labs.google/fx/*/tools/flow*',
  ],
  runAt: 'document_start',

  async main() {
    // Pull the MAIN-world script in. `keepInDom` keeps the <script> element
    // around so we can use its event listener to receive the result.
    await injectScript('/flow-bridge-main.js', { keepInDom: true });

    // ─── Background → MAIN: captcha request ──────────────────
    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      const msg = raw as Partial<CaptchaRequestMessage> | undefined;
      if (!msg || msg.type !== 'GET_CAPTCHA') return;
      if (!msg.requestId || !msg.pageAction) return;

      const { requestId, pageAction } = msg;

      const onResult = (event: Event) => {
        const detail = (event as CustomEvent<{ requestId: string; token?: string; error?: string }>).detail;
        if (!detail || detail.requestId !== requestId) return;
        window.removeEventListener('CAPTCHA_RESULT', onResult);
        clearTimeout(timer);
        sendResponse({ token: detail.token, error: detail.error });
      };

      const timer = setTimeout(() => {
        window.removeEventListener('CAPTCHA_RESULT', onResult);
        sendResponse({ error: 'CONTENT_TIMEOUT' });
      }, CAPTCHA_TIMEOUT_MS);

      window.addEventListener('CAPTCHA_RESULT', onResult);
      window.dispatchEvent(
        new CustomEvent('GET_CAPTCHA', { detail: { requestId, pageAction } }),
      );

      return true; // keep channel open for async sendResponse
    });

    // ─── MAIN → background: TRPC media URL payload ───────────
    window.addEventListener('TRPC_MEDIA_URLS', (event) => {
      const detail = (event as CustomEvent<TrpcMediaEventDetail>).detail;
      if (!detail?.body) return;
      void chrome.runtime.sendMessage({
        type: 'TRPC_MEDIA_URLS',
        trpcUrl: detail.url,
        body: detail.body,
      });
    });

    // ─── MAIN → background: captured generation request template ──
    window.addEventListener('FLOW_GEN_TEMPLATE', (event) => {
      const detail = (event as CustomEvent<{ url: string; body: unknown; headers?: Record<string, string> }>).detail;
      if (!detail?.url) return;
      void chrome.runtime.sendMessage({
        type: 'FLOW_GEN_TEMPLATE',
        url: detail.url,
        body: detail.body,
        headers: detail.headers,
      });
    });
  },
});

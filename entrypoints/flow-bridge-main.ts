/**
 * MAIN-world script — runs on labs.google/fx/tools/flow alongside the
 * page's own JavaScript. It has access to:
 *
 *  • `window.grecaptcha.enterprise.execute(SITE_KEY, { action })`
 *  • The page's `window.fetch`
 *
 * Responsibilities:
 *  • Listen for `GET_CAPTCHA` custom events from the ISOLATED bridge,
 *    mint a fresh enterprise reCAPTCHA token, and emit `CAPTCHA_RESULT`.
 *  • Monkey-patch `window.fetch` to clone TRPC responses and emit
 *    `TRPC_MEDIA_URLS` whenever a body contains fresh signed GCS URLs.
 */

import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const GRECAPTCHA_WAIT_TIMEOUT_MS = 10_000;
// Bucket-agnostic: any signed GCS media URL with an image/video path segment.
const STORAGE_MEDIA_RE = /storage\.googleapis\.com\/[A-Za-z0-9._-]+\/(?:image|video)\//;
// Real Flow generation endpoints we learn request templates from.
const GEN_ENDPOINT_RE = /(batchGenerateImages|batchAsyncGenerateVideo|ReferenceImages|batchCheckAsync|uploadImage)/;

/** Only scan API responses where media URLs could appear — skip the GCS assets
 *  themselves and unrelated hosts. */
function shouldScan(url: string): boolean {
  if (!url) return false;
  if (url.includes('storage.googleapis.com')) return false; // the asset itself
  return /labs\.google|aisandbox-pa\.googleapis\.com/.test(url);
}

/** Dispatch captured project media to the ISOLATED bridge if the body carries
 *  signed GCS media URLs. */
function scanForMedia(url: string, text: string, via: string): void {
  if (STORAGE_MEDIA_RE.test(text)) {
    console.log(`[FlowHelper] media URLs found via ${via}:`, url);
    window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', { detail: { url, body: text } }));
  }
}

async function readRequestBody(args: Parameters<typeof fetch>): Promise<string | null> {
  const init = args[1];
  if (init && typeof init.body === 'string') return init.body;
  // fetch(new Request(url, { body })) — body lives on the Request, not init.
  try {
    if (args[0] instanceof Request) {
      const text = await args[0].clone().text();
      if (text) return text;
    }
  } catch {
    /* body already consumed / not readable */
  }
  // URLSearchParams / other stringifiable bodies.
  if (init && init.body != null && typeof init.body !== 'object') return String(init.body);
  return null;
}

function readRequestHeaders(args: Parameters<typeof fetch>): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const init = args[1];
    const src = init?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined);
    if (!src) return out;
    new Headers(src).forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    /* ignore */
  }
  return out;
}

interface Greaptcha {
  enterprise: {
    execute(siteKey: string, opts: { action: string }): Promise<string>;
  };
}

interface GetCaptchaDetail {
  requestId: string;
  pageAction: string;
}

declare global {
  interface Window {
    grecaptcha?: Greaptcha;
  }
}

function waitForGrecaptcha(timeout = GRECAPTCHA_WAIT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error('grecaptcha not available'));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

export default defineUnlistedScript(() => {
  // ─── fetch patch — capture TRPC media URLs ─────────────────
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>): Promise<Response> {
    const response = await originalFetch(...args);
    try {
      const input = args[0];
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url ?? '';

      // ── capture real generation requests as replay templates ──
      if (GEN_ENDPOINT_RE.test(url)) {
        const rawBody = await readRequestBody(args);
        console.log('[FlowHelper] gen request seen:', url, rawBody ? '(body ok)' : '(NO BODY — cannot capture)');
        if (rawBody) {
          let parsed: unknown = rawBody;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            /* keep raw string */
          }
          window.dispatchEvent(
            new CustomEvent('FLOW_GEN_TEMPLATE', {
              detail: { url, body: parsed, headers: readRequestHeaders(args) },
            }),
          );
        }
      }

      // Scan any API response (not just trpc) for project media URLs.
      if (response.ok && shouldScan(url)) {
        response
          .clone()
          .text()
          .then((text) => scanForMedia(url, text, 'fetch'))
          .catch(() => {});
      }
    } catch {
      // ignore — telemetry is best-effort
    }
    return response;
  };

  // ─── XHR patch — some Flow data calls use XMLHttpRequest ───
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (this: XMLHttpRequest & { __flowUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__flowUrl = typeof url === 'string' ? url : url.toString();
      // @ts-expect-error — passthrough to native signature
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.send = function (this: XMLHttpRequest & { __flowUrl?: string }, ...sendArgs: unknown[]) {
      this.addEventListener('load', () => {
        try {
          const url = this.__flowUrl ?? '';
          if (!shouldScan(url)) return;
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (text) scanForMedia(url, text, 'xhr');
        } catch {
          /* ignore */
        }
      });
      // @ts-expect-error — passthrough to native signature
      return origSend.apply(this, sendArgs);
    };
  } catch {
    /* XHR patch is best-effort */
  }

  // ─── captcha handler ───────────────────────────────────────
  window.addEventListener('GET_CAPTCHA', async (event: Event) => {
    const detail = (event as CustomEvent<GetCaptchaDetail>).detail;
    const { requestId, pageAction } = detail ?? {};
    if (!requestId || !pageAction) return;

    try {
      await waitForGrecaptcha();
      const token = await window.grecaptcha!.enterprise.execute(SITE_KEY, { action: pageAction });
      window.dispatchEvent(
        new CustomEvent('CAPTCHA_RESULT', { detail: { requestId, token } }),
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('CAPTCHA_RESULT', {
          detail: { requestId, error: (e as Error).message },
        }),
      );
    }
  });
});

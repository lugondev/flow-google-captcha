/**
 * Flow Helper — Background Service Worker
 *
 *  • Captures the user's Google bearer token from outgoing Flow API calls.
 *  • Solves enterprise reCAPTCHA from the active Flow tab.
 *  • Drives Google Flow generation directly from the side panel (image/video,
 *    references, auto-retry) by replaying request templates learned from the
 *    live page. No external agent.
 *  • Emits human-like telemetry to keep the session looking organic.
 */

import { defineBackground } from 'wxt/utils/define-background';

import { state, loadPersisted, setAppState } from './state';
import { solveCaptcha, FLOW_TAB_URLS } from './captcha';
import { handleTrpcMediaUrls, getProjectMedia, loadProjectMedia } from './trpc-media';
import {
  fetchProjectMedia,
  enrichWithUrls,
  fetchModelMap,
  projectIdFromUrl,
  workflowIdFromUrl,
} from './project-media';
import { startTelemetry } from './telemetry';
import { getRequestLog } from './log';
import { loadTemplates, getTemplates, recordTemplate, runGenerate } from './generate';
import type { GenerateParams, GenProgress, GenResult } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let openingFlowTab = false;

export default defineBackground({
  type: 'module',

  async main() {
    await loadPersisted();
    await loadTemplates();
    await loadProjectMedia();

    // Clicking the toolbar icon opens the side panel directly (no popup).
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.error('[FlowAgent] setPanelBehavior failed:', e));

    // Active session (no agent gating) so telemetry + UI reflect a live state.
    setAppState('idle');
    void chrome.alarms.create('token-refresh', { periodInMinutes: 45 });

    // ── Alarms ─────────────────────────────────────────────
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'token-refresh') await captureTokenFromFlowTab();
    });

    // ── Bearer-token capture (webRequest) ──────────────────
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (!details?.requestHeaders?.length) return;
        const authHeader = details.requestHeaders.find(
          (h) => h.name?.toLowerCase() === 'authorization',
        );
        const value = authHeader?.value || '';
        if (!value.startsWith('Bearer ya29.')) return;

        const token = value.replace(/^Bearer\s+/i, '').trim();
        if (!token) return;

        state.flowKey = token;
        state.metrics.tokenCapturedAt = Date.now();
        void chrome.storage.local.set({ flowKey: token, metrics: state.metrics });
        console.log('[FlowAgent] Bearer token captured');
      },
      { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
      ['requestHeaders', 'extraHeaders'],
    );

    // ── Popup / side panel message bus ─────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      const handled = handleUiMessage(msg, reply);
      if (!handled) reply({});
      return true;
    });

    startTelemetry();
    console.log('[FlowAgent] Extension loaded');
  },
});

// ─── Token capture (active Flow tab) ──────────────────────

async function captureTokenFromFlowTab(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
  if (!tabs.length) {
    if (openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    openingFlowTab = true;
    try {
      console.log('[FlowAgent] No Flow tab found — opening one in background');
      await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: false });
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
      if (!retryTabs.length) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      const tabId = retryTabs[0]!.id!;
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/flow-bridge.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      openingFlowTab = false;
    }
    return;
  }
  try {
    const tabId = tabs[0]!.id!;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/flow-bridge.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}

/** Wait until a tab finishes loading (or timeout) before touching it. */
function waitForTabComplete(tabId: number, timeout = 15000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve();
      } catch {
        return resolve(); // tab gone — nothing to wait for
      }
      if (Date.now() - start > timeout) return resolve();
      setTimeout(check, 300);
    };
    void check();
  });
}

/** Hard session recovery for 403s: reload the Flow tab so Google issues a fresh
 *  session, wait for it, then let its requests re-capture the bearer token. */
async function reloadFlowTabAndSync(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
  if (!tabs.length) {
    // No Flow tab open — fall back to opening one + capturing.
    await captureTokenFromFlowTab();
    return;
  }
  const tabId = tabs[0]!.id!;
  try {
    console.log('[FlowAgent] 403 recovery — reloading Flow tab', tabId);
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await waitForTabComplete(tabId);
    // Give the freshly loaded page a moment to fire its authenticated calls so
    // the webRequest listener re-captures a fresh bearer token automatically.
    await sleep(1500);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/flow-bridge.js'],
    });
    console.log('[FlowAgent] 403 recovery — Flow tab reloaded + token re-synced');
  } catch (e) {
    console.error('[FlowAgent] 403 recovery failed:', e);
  }
}

// ─── Popup / side panel message router ───────────────────

type UiReply = (response?: unknown) => void;
type UiMessage = { type: string; [k: string]: unknown };

function handleUiMessage(msg: UiMessage, reply: UiReply): boolean {
  switch (msg.type) {
    case 'STATUS': {
      reply({
        flowKeyPresent: !!state.flowKey,
        tokenAge: state.metrics.tokenCapturedAt
          ? Date.now() - state.metrics.tokenCapturedAt
          : null,
        metrics: {
          requestCount: state.metrics.requestCount,
          successCount: state.metrics.successCount,
          failedCount: state.metrics.failedCount,
          lastError: state.metrics.lastError,
        },
        state: state.appState,
      });
      return true;
    }

    case 'REQUEST_LOG':
      reply({ log: getRequestLog() });
      return true;

    case 'OPEN_FLOW_TAB':
      void openFlowTab(reply);
      return true;

    case 'REFRESH_TOKEN':
      captureTokenFromFlowTab()
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ error: (e as Error).message }));
      return true;

    case 'TEST_CAPTCHA':
      solveCaptcha(`test-${Date.now()}`, (msg.pageAction as string) || 'IMAGE_GENERATION')
        .then((r) => reply(r))
        .catch((e) => reply({ error: (e as Error).message }));
      return true;

    case 'TRPC_MEDIA_URLS':
      handleTrpcMediaUrls(msg.trpcUrl as string, msg.body as string);
      reply({ ok: true });
      return true;

    case 'FLOW_GEN_TEMPLATE':
      void recordTemplate(
        msg.url as string,
        msg.body,
        msg.headers as Record<string, string> | undefined,
      );
      reply({ ok: true });
      return true;

    case 'GET_PROJECT_MEDIA':
      void resolveProjectMedia(msg.projectId as string | undefined, reply);
      return true;

    case 'GET_TEMPLATES': {
      const t = getTemplates();
      reply({
        image: true, // built-in default schema — no capture needed
        imageBuiltIn: !t.image,
        video: !!t.video,
        videoPoll: !!t.videoPoll,
        imageAt: t.image?.capturedAt ?? null,
        videoAt: t.video?.capturedAt ?? null,
      });
      return true;
    }

    case 'GENERATE': {
      const params = msg.params as GenerateParams;
      const runId = `gen-${Date.now()}`;
      // Bind the request to the project/workflow currently open in the Flow tab.
      void (async () => {
        const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
        for (const t of tabs) {
          params.projectId = params.projectId || projectIdFromUrl(t.url) || undefined;
          params.workflowId = params.workflowId || workflowIdFromUrl(t.url) || undefined;
          if (params.projectId && params.workflowId) break;
        }
        // Translate the model-family id (nano_banana_pro) → real imageModelName.
        if (params.model && params.projectId) {
          const mmap = await fetchModelMap(params.projectId);
          if (mmap[params.model]) {
            console.log(`[FlowGen] model ${params.model} → ${mmap[params.model]}`);
            params.model = mmap[params.model];
          } else {
            console.warn(`[FlowGen] no imageModelName mapping for "${params.model}" — sending as-is`);
          }
        }
        runGenerate(runId, params, {
          onProgress: (p: GenProgress) => {
            chrome.runtime.sendMessage({ type: 'GEN_PROGRESS', progress: p }).catch(() => {});
          },
          refreshToken: () => captureTokenFromFlowTab(),
          reloadFlowTab: () => reloadFlowTabAndSync(),
        })
          .then((result: GenResult) => reply(result))
          .catch((e) => reply({ runId, ok: false, media: [], attempts: 0, error: (e as Error).message }));
      })();
      return true;
    }

    default:
      return false;
  }
}

async function resolveProjectMedia(
  projectId: string | undefined,
  reply: UiReply,
): Promise<void> {
  try {
    let pid = projectId || null;
    let wfid: string | null = null;
    if (!pid) {
      const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
      for (const t of tabs) {
        pid = pid || projectIdFromUrl(t.url);
        wfid = wfid || workflowIdFromUrl(t.url);
        if (pid && wfid) break;
      }
    }
    if (!pid) {
      reply({ error: 'NO_PROJECT: mở một project Flow trong tab để lấy ảnh', media: [] });
      return;
    }

    const all = await fetchProjectMedia(pid);

    // Scope references to the current workflow (so they're valid in the request).
    // Fall back to the whole project if the workflow has none yet.
    let items = wfid ? all.filter((it) => it.workflowId === wfid) : all;
    let scoped = true;
    if (!items.length) {
      items = all;
      scoped = false;
    }

    await enrichWithUrls(items);

    // Backfill any still-missing URL from passively-captured serving URLs.
    const passive = getProjectMedia();
    for (const it of items) {
      if (!it.url) {
        const hit = passive.find((p) => p.mediaId === it.mediaId || p.url.includes(it.mediaId));
        if (hit) it.url = hit.url;
      }
    }
    reply({ media: items, projectId: pid, workflowId: wfid, scoped });
  } catch (e) {
    reply({ error: (e as Error).message, media: [] });
  }
}

async function openFlowTab(reply: UiReply): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
    if (tabs.length) {
      const tab = tabs[0]!;
      await chrome.tabs.update(tab.id!, { active: true });
      reply({ ok: true, tabId: tab.id });
      return;
    }
    const tab = await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
    reply({ ok: true, tabId: tab.id });
  } catch (e) {
    reply({ error: (e as Error).message });
  }
}

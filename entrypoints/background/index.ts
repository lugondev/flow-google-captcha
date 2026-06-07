/**
 * Flow Kit — Background Service Worker
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
import { fetchProjectMedia, projectIdFromUrl } from './project-media';
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
        image: !!t.image,
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
      runGenerate(runId, params, {
        onProgress: (p: GenProgress) => {
          chrome.runtime.sendMessage({ type: 'GEN_PROGRESS', progress: p }).catch(() => {});
        },
        refreshToken: () => captureTokenFromFlowTab(),
      })
        .then((result: GenResult) => reply(result))
        .catch((e) => reply({ runId, ok: false, media: [], attempts: 0, error: (e as Error).message }));
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
    if (!pid) {
      const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
      for (const t of tabs) {
        pid = projectIdFromUrl(t.url);
        if (pid) break;
      }
    }
    if (!pid) {
      reply({ error: 'NO_PROJECT: mở một project Flow trong tab để lấy ảnh', media: [] });
      return;
    }

    const items = await fetchProjectMedia(pid);

    // Enrich missing thumbnails from passively-captured serving URLs.
    const passive = getProjectMedia();
    for (const it of items) {
      if (!it.url) {
        const hit = passive.find((p) => p.mediaId === it.mediaId || p.url.includes(it.mediaId));
        if (hit) it.url = hit.url;
      }
    }
    reply({ media: items, projectId: pid });
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

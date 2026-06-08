/**
 * Global service-worker state + persistent storage sync.
 */

import type { AppState, Metrics } from './types';

const initialMetrics: Metrics = {
  tokenCapturedAt: null,
  requestCount: 0,
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

export const state = {
  flowKey: null as string | null,
  appState: 'off' as AppState,
  metrics: { ...initialMetrics },
};

const BADGES: Record<AppState, string> = { idle: '●', running: '▶', off: '○' };
const COLORS: Record<AppState, string> = {
  idle: '#22c55e',
  running: '#f59e0b',
  off: '#6b7280',
};

export async function loadPersisted(): Promise<void> {
  const data = await chrome.storage.local.get(['flowKey', 'metrics']);
  if (data.flowKey) state.flowKey = data.flowKey;
  if (data.metrics && typeof data.metrics === 'object') {
    Object.assign(state.metrics, data.metrics);
  }
}

export function setAppState(next: AppState): void {
  state.appState = next;
  void chrome.action.setBadgeText({ text: '' });
  broadcastStatus();
}

export function broadcastStatus(): void {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

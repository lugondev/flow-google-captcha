/**
 * In-memory request log + classification.
 *
 * Mirrors flowkit's `requestLog` array in background.js — at most 100 entries,
 * newest first. Only the subset of API calls that actually consume a captcha
 * or represent user-visible activity is shown in the popup/side panel.
 */

import type { RequestLogEntry, RequestLogStatus } from './types';
import { state, broadcastStatus } from './state';

/** Keep the Total/Success/Failed counters in lock-step with the visible
 *  request-log rows, then persist + push so the side panel reflects it live. */
function bumpMetric(field: 'requestCount' | 'successCount' | 'failedCount'): void {
  state.metrics[field] += 1;
  void chrome.storage.local.set({ metrics: state.metrics });
  broadcastStatus();
}

const VISIBLE_TYPES = new Set<string>([
  'GEN_IMG',
  'GEN_VID',
  'GEN_VID_REF',
  'UPSCALE',
  'TRACKING',
  'URL_REFRESH',
]);

const requestLog: RequestLogEntry[] = [];

export function getRequestLog(): RequestLogEntry[] {
  return requestLog;
}

export function classifyApiUrl(url: string): string {
  if (url.includes('uploadImage')) return 'UPLOAD';
  if (url.includes('batchGenerateImages')) return 'GEN_IMG';
  if (url.includes('UpsampleVideo')) return 'UPSCALE';
  if (url.includes('ReferenceImages')) return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync')) return 'POLL';
  if (url.includes('upsampleImage')) return 'UPS_IMG';
  if (url.includes('/media/')) return 'MEDIA';
  if (url.includes('/credits')) return 'CREDITS';
  return 'API';
}

export function startLogEntry(id: string, url: string, body?: unknown): string {
  const logType = classifyApiUrl(url);
  if (VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body !== undefined ? JSON.stringify(body).slice(0, 200) : undefined;
    const entry: RequestLogEntry = {
      id,
      type: logType,
      time: new Date().toISOString(),
      status: 'processing',
      error: null,
      outputUrl: null,
      url,
      ...(payloadSummary !== undefined ? { payloadSummary } : {}),
    };
    requestLog.unshift(entry);
    if (requestLog.length > 100) requestLog.pop();
    bumpMetric('requestCount');
    broadcastLog();
  }
  return logType;
}

export function markLogSuccess(
  id: string,
  httpStatus?: number,
  responseSummary?: string,
  media?: { type: 'image' | 'video'; url?: string; dataUri?: string }[],
): void {
  const outputs = (media ?? [])
    .map((m) => ({ type: m.type, url: m.url || m.dataUri || '' }))
    .filter((m) => m.url);
  updateLogEntry(id, {
    status: 'success',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(responseSummary !== undefined ? { responseSummary } : {}),
    ...(outputs.length ? { outputs, outputUrl: outputs[0]!.url } : {}),
  });
}

export function markLogFailed(
  id: string,
  error: string,
  httpStatus?: number,
  responseSummary?: string,
): void {
  updateLogEntry(id, {
    status: 'failed' satisfies RequestLogStatus,
    error,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(responseSummary !== undefined ? { responseSummary } : {}),
  });
}

function updateLogEntry(id: string, updates: Partial<RequestLogEntry>): void {
  const entry = requestLog.find((e) => e.id === id);
  if (!entry) return;
  // Count the terminal transition once (processing → success/failed).
  if (entry.status === 'processing' && updates.status === 'success') bumpMetric('successCount');
  else if (entry.status === 'processing' && updates.status === 'failed') bumpMetric('failedCount');
  Object.assign(entry, updates);
  broadcastLog();
}

function broadcastLog(): void {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

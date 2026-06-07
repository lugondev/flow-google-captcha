/**
 * Pulls fresh signed GCS media URLs out of tRPC response bodies and forwards
 * them to the agent so the database can stay up to date.
 */

import type { MediaUrlRef } from './types';

// Tolerant: any signed GCS URL. We classify type + derive an id afterwards,
// so we don't depend on the exact `/image/<uuid>` path shape.
const STORAGE_URL_RE = /https:\/\/storage\.googleapis\.com\/[^"'\\\s)<>]+/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// Recent project media seen on the live page — newest first, deduped by id.
// Used by the side panel to let the user pick reference images.
const MAX_PROJECT_MEDIA = 60;
const PROJECT_MEDIA_KEY = 'projectMedia';
const projectMedia: MediaUrlRef[] = [];

export function getProjectMedia(): MediaUrlRef[] {
  return projectMedia;
}

/** Restore persisted project media so the picker survives worker restarts. */
export async function loadProjectMedia(): Promise<void> {
  const data = await chrome.storage.local.get(PROJECT_MEDIA_KEY);
  const saved = data[PROJECT_MEDIA_KEY];
  if (Array.isArray(saved)) {
    projectMedia.splice(0, projectMedia.length, ...(saved as MediaUrlRef[]));
  }
}

export function handleTrpcMediaUrls(_trpcUrl: string, bodyText: string): void {
  try {
    const matches = bodyText.match(STORAGE_URL_RE) ?? [];
    if (!matches.length) return;

    const byId = new Map<string, MediaUrlRef>();
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const isVideo = /\/video\//.test(url) || /\.(mp4|webm|mov)(\?|$)/.test(url);
      const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';
      const mediaId = url.match(UUID_RE)?.[0] || url.split('?')[0]!;
      byId.set(mediaId, { mediaType, url, mediaId });
    }

    const entries = [...byId.values()];
    if (!entries.length) return;

    // Merge into the project media list (refresh url for known ids, prepend new).
    for (const ref of entries) {
      const idx = projectMedia.findIndex((p) => p.mediaId === ref.mediaId);
      if (idx >= 0) projectMedia[idx] = ref;
      else projectMedia.unshift(ref);
    }
    if (projectMedia.length > MAX_PROJECT_MEDIA) projectMedia.length = MAX_PROJECT_MEDIA;

    console.log(
      `[FlowAgent] Captured ${entries.length} media URLs from TRPC (project total: ${projectMedia.length})`,
    );
    void chrome.storage.local.set({ [PROJECT_MEDIA_KEY]: projectMedia });
    chrome.runtime.sendMessage({ type: 'PROJECT_MEDIA_UPDATE', media: projectMedia }).catch(() => {});
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}

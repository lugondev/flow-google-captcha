/**
 * Project media via the live Flow API (no DOM scraping, no agent).
 *
 * Calls the same tRPC endpoint the Flow page uses on load —
 *   GET /fx/api/trpc/flow.projectInitialData?input={"json":{"projectId":...}}
 * authenticated by the user's session cookies (credentials: 'include').
 *
 * Returns the project's media list so the side panel can offer existing images
 * as generation references. References attach by `mediaId` — exactly the field
 * Flow itself uses (imageGenerationRequestData.imageGenerationImageInputs[].mediaId).
 */

const TRPC_BASE = 'https://labs.google/fx/api/trpc/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const GCS_URL_RE = /https:\/\/storage\.googleapis\.com\/[^"'\\\s)<>]+/g;
const RESOLVE_CONCURRENCY = 6;

export interface ProjectMediaItem {
  mediaId: string;
  type: 'image' | 'video';
  prompt: string;
  model: string;
  aspectRatio: string;
  url?: string; // serving/signed URL if present in the payload
  width?: number;
  height?: number;
}

/** Pull the projectId out of a Flow tab URL: …/project/<id>/… */
export function projectIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.match(/\/project\/([0-9a-f-]{36})/)?.[1] ?? null;
}

export async function fetchProjectMedia(projectId: string): Promise<ProjectMediaItem[]> {
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  const url = `${TRPC_BASE}flow.projectInitialData?input=${input}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    credentials: 'include',
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error('[FlowGen] projectInitialData', resp.status, text.slice(0, 300));
    throw new Error(`PROJECT_FETCH_${resp.status}`);
  }

  const data = JSON.parse(text);
  const mediaList: unknown[] =
    data?.result?.data?.json?.projectContents?.media ?? [];

  // Map any signed GCS URLs in the payload by their uuid so we can attach
  // thumbnails when the API includes them.
  const urlByUuid = new Map<string, string>();
  for (const raw of text.match(GCS_URL_RE) ?? []) {
    const clean = raw.replace(/\\u0026/g, '&').replace(/\\/g, '');
    const uuid = clean.match(UUID_RE)?.[0];
    if (uuid && !urlByUuid.has(uuid)) urlByUuid.set(uuid, clean);
  }

  const items: ProjectMediaItem[] = [];
  for (const m of mediaList) {
    const item = parseMedia(m as Record<string, unknown>, urlByUuid);
    if (item) items.push(item);
  }

  // Resolve a displayable link for items the payload didn't already include,
  // via media.getMediaUrlRedirect (response carries the GCS `location`).
  await resolveLocations(items.filter((it) => !it.url));

  const withUrl = items.filter((it) => it.url).length;
  console.log(`[FlowGen] projectInitialData → ${items.length} media, ${withUrl} with URL`);
  return items;
}

/** GET media.getMediaUrlRedirect?name=<id> → the image's GCS `location`. */
export async function resolveMediaLocation(mediaId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${TRPC_BASE}media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}`, {
      method: 'GET',
      headers: { accept: '*/*' },
      credentials: 'include',
    });
    if (!resp.ok) return null;
    // A 302 may have been auto-followed straight to the GCS asset.
    if (resp.redirected && resp.url.includes('storage.googleapis.com')) return resp.url;
    const text = await resp.text();
    try {
      const loc = deepFindLocation(JSON.parse(text));
      if (loc) return loc;
    } catch {
      /* not JSON */
    }
    const m = text.match(GCS_URL_RE)?.[0];
    return m ? m.replace(/\\u0026/g, '&').replace(/\\/g, '') : null;
  } catch {
    return null;
  }
}

function deepFindLocation(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (typeof val === 'string' && /^location$|url$|uri$/i.test(key) && /^https?:\/\//.test(val)) {
      return val;
    }
    if (typeof val === 'object') {
      const found = deepFindLocation(val);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve locations in small concurrent batches to avoid hammering the API. */
async function resolveLocations(items: ProjectMediaItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += RESOLVE_CONCURRENCY) {
    const batch = items.slice(i, i + RESOLVE_CONCURRENCY);
    await Promise.all(
      batch.map(async (it) => {
        const url = await resolveMediaLocation(it.mediaId);
        if (url) it.url = url;
      }),
    );
  }
}

function parseMedia(
  m: Record<string, unknown>,
  urlByUuid: Map<string, string>,
): ProjectMediaItem | null {
  const image = (m.image as Record<string, unknown> | undefined)?.generatedImage as
    | Record<string, unknown>
    | undefined;
  const video = (m.video as Record<string, unknown> | undefined)?.generatedVideo as
    | Record<string, unknown>
    | undefined;
  const gen = image ?? video;
  const type: 'image' | 'video' = video ? 'video' : 'image';

  const meta = (m.mediaMetadata as Record<string, unknown> | undefined)?.requestData as
    | Record<string, unknown>
    | undefined;
  const promptInputs = (meta?.promptInputs as Array<Record<string, unknown>> | undefined) ?? [];

  // getMediaUrlRedirect expects `name=<uuid>`; the media's `name` field carries it.
  const nameStr = (m.name as string | undefined) || '';
  const mediaId =
    nameStr.match(UUID_RE)?.[0] ||
    (gen?.mediaGenerationId as string | undefined) ||
    nameStr;
  if (!mediaId) return null;

  const prompt =
    (gen?.prompt as string | undefined) ||
    (promptInputs[0]?.textInput as string | undefined) ||
    '';
  const model = (gen?.modelNameType as string | undefined) || '';
  const aspectRatio = (gen?.aspectRatio as string | undefined) || '';
  const dims = (m.image as Record<string, unknown> | undefined)?.dimensions as
    | { width?: number; height?: number }
    | undefined;

  const uuid = mediaId.match(UUID_RE)?.[0];
  const url = uuid ? urlByUuid.get(uuid) : undefined;

  return { mediaId, type, prompt, model, aspectRatio, url, width: dims?.width, height: dims?.height };
}

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
  workflowId?: string;
  url?: string; // serving/signed URL if present in the payload
  width?: number;
  height?: number;
}

/** Pull the projectId out of a Flow tab URL: …/project/<id>/… */
export function projectIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.match(/\/project\/([0-9a-f-]{36})/)?.[1] ?? null;
}

/** Pull the current workflowId out of a Flow tab URL: …/edit/<id> */
export function workflowIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.match(/\/edit\/([0-9a-f-]{36})/)?.[1] ?? null;
}

export interface UserProject {
  projectId: string;
  title: string;
  thumbnailMediaKey?: string;
  creationTime?: string;
}

/** List the signed-in user's Flow projects via project.searchUserProjects. */
export async function fetchUserProjects(pageSize = 20): Promise<UserProject[]> {
  const input = encodeURIComponent(
    JSON.stringify({
      json: { pageSize, toolName: 'PINHOLE', cursor: null },
      meta: { values: { cursor: ['undefined'] } },
    }),
  );
  const resp = await fetch(`${TRPC_BASE}project.searchUserProjects?input=${input}`, {
    method: 'GET',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    credentials: 'include',
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error('[FlowGen] searchUserProjects', resp.status, text.slice(0, 200));
    throw new Error(`PROJECTS_FETCH_${resp.status}`);
  }
  const data = JSON.parse(text);
  const projects: Array<Record<string, unknown>> = data?.result?.data?.json?.result?.projects ?? [];
  return projects
    .map((p) => {
      const info = (p.projectInfo as Record<string, unknown>) || {};
      return {
        projectId: p.projectId as string,
        title: (info.projectTitle as string) || (p.projectId as string),
        thumbnailMediaKey: info.thumbnailMediaKey as string | undefined,
        creationTime: p.creationTime as string | undefined,
      };
    })
    .filter((p) => p.projectId);
}

export interface VideoModelFamily {
  id: string;
  displayName: string;
  durations: number[]; // distinct videoLengthSeconds available for the user's tier
}

// Raw families + tier cached per project so the usage-key resolver can run.
let videoCache: { projectId: string; tier: string; raw: Array<Record<string, unknown>> } | null = null;

function usageAvailable(u: Record<string, unknown>, tier: string): boolean {
  const cm = (u.creditMapping as Record<string, { cost?: unknown }>) || {};
  const cost = cm[tier]?.cost;
  return cost != null && cost !== 'UNAVAILABLE';
}

/** Video model families + per-tier available durations (for the model/time picker). */
export async function fetchVideoModels(projectId: string): Promise<VideoModelFamily[]> {
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  const resp = await fetch(`${TRPC_BASE}flow.projectInitialData?input=${input}`, {
    method: 'GET',
    headers: { accept: '*/*' },
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`VIDEO_MODELS_${resp.status}`);
  const json = (await resp.json())?.result?.data?.json;
  const tier = (json?.userData?.serviceTier as string) || 'SERVICE_TIER_INTERMEDIATE';
  const raw: Array<Record<string, unknown>> = json?.modelConfig?.videoModelFamilies ?? [];
  videoCache = { projectId, tier, raw };

  const out: VideoModelFamily[] = [];
  for (const f of raw) {
    const id = f.id as string;
    if (!id || /upsampler|low_priority/.test(id)) continue; // hide upscalers + low-priority dupes
    const durs = new Set<number>();
    for (const u of (f.usages as Array<Record<string, unknown>>) ?? []) {
      const len = u.videoLengthSeconds;
      if (typeof len === 'number' && usageAvailable(u, tier)) durs.add(len);
    }
    out.push({ id, displayName: f.displayName as string, durations: [...durs].sort((a, b) => a - b) });
  }
  return out;
}

/** Resolve a videoModelKey usage key from (family, duration, orientation, mode). */
export async function resolveVideoModelKey(
  projectId: string | undefined,
  familyId: string,
  durationSec: number | undefined,
  orientation: string | undefined,
  mode: 't2v' | 'i2v' | 'startend' | 'r2v',
): Promise<string | null> {
  if (!projectId) return null;
  if (!videoCache || videoCache.projectId !== projectId) await fetchVideoModels(projectId);
  if (!videoCache) return null;
  const tier = videoCache.tier;
  const family = videoCache.raw.find((f) => f.id === familyId);
  if (!family) return null;
  const orient = orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT'; // video has no square
  const reqOf = (u: Record<string, unknown>) =>
    JSON.stringify((u.requirements as unknown[]) ?? []);

  const usages = ((family.usages as Array<Record<string, unknown>>) ?? []).filter((u) => {
    if (!usageAvailable(u, tier)) return false;
    if (durationSec != null && typeof u.videoLengthSeconds === 'number' && u.videoLengthSeconds !== durationSec)
      return false;
    const ars = (u.supportedAspectRatios as string[] | string) ?? [];
    const arr = Array.isArray(ars) ? ars : String(ars).split(',');
    return arr.includes(orient);
  });
  if (!usages.length) return null;

  // Pick the usage whose requirements match the requested mode.
  const byKind = (pred: (req: string) => boolean) => usages.find((u) => pred(reqOf(u)));
  let chosen: Record<string, unknown> | undefined;
  if (mode === 'r2v') chosen = byKind((r) => r.includes('REFERENCES'));
  else if (mode === 'startend') chosen = byKind((r) => r.includes('START_IMAGE') && r.includes('END_IMAGE'));
  else if (mode === 'i2v') chosen = byKind((r) => r.includes('START_IMAGE') && !r.includes('END_IMAGE'));
  else chosen = byKind((r) => r.includes('TEXT') && !r.includes('START_IMAGE') && !r.includes('REFERENCES') && !r.includes('END_IMAGE'));
  // Fallbacks: i2v→start-end, startend→i2v, anything→first available.
  if (!chosen && mode === 'i2v') chosen = byKind((r) => r.includes('START_IMAGE'));
  if (!chosen && mode === 'startend') chosen = byKind((r) => r.includes('START_IMAGE'));
  if (!chosen) chosen = usages[0];
  const key = chosen?.key as string | undefined;
  if (key) console.log(`[FlowGen] video model resolved: ${familyId}/${durationSec ?? '?'}s/${orient}/${mode} → ${key}`);
  else console.warn(`[FlowGen] no video model key for ${familyId}/${mode}`);
  return key ?? null;
}

/** Rename a project via project.updateProject (projectTitle mask). */
export async function updateProjectTitle(projectId: string, title: string): Promise<void> {
  const resp = await fetch(`${TRPC_BASE}project.updateProject`, {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      json: {
        projectId,
        projectInfo: { projectTitle: title },
        updateMasks: ['projectTitle'],
        toolName: 'PINHOLE',
      },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error('[FlowGen] updateProject', resp.status, t.slice(0, 200));
    throw new Error(`UPDATE_PROJECT_${resp.status}`);
  }
}

/** Distinct workflows of a project that already have media (id + media count). */
export async function fetchProjectWorkflows(
  projectId: string,
): Promise<Array<{ workflowId: string; count: number }>> {
  const items = await fetchProjectMedia(projectId);
  const counts = new Map<string, number>();
  for (const it of items) {
    if (it.workflowId) counts.set(it.workflowId, (counts.get(it.workflowId) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([workflowId, count]) => ({ workflowId, count }))
    .sort((a, b) => b.count - a.count);
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
  console.log(`[FlowGen] projectInitialData → ${items.length} media`);
  return items;
}

/** Resolve displayable links (media.getMediaUrlRedirect) for items lacking one,
 *  in small concurrent batches. Call AFTER filtering to the current workflow. */
export async function enrichWithUrls(items: ProjectMediaItem[]): Promise<void> {
  const pending = items.filter((it) => !it.url);
  for (let i = 0; i < pending.length; i += RESOLVE_CONCURRENCY) {
    const batch = pending.slice(i, i + RESOLVE_CONCURRENCY);
    await Promise.all(
      batch.map(async (it) => {
        const url = await resolveMediaLocation(it.mediaId);
        if (url) it.url = url;
      }),
    );
  }
  console.log(`[FlowGen] resolved ${items.filter((it) => it.url).length}/${items.length} URLs`);
}

/** Map a model-family id (e.g. nano_banana_pro) → the real `imageModelName`
 *  enum the request expects, using Flow's own modelConfig. Logs every family
 *  so the available model keys are visible. */
let modelMapCache: Record<string, string> | null = null;
export async function fetchModelMap(projectId: string): Promise<Record<string, string>> {
  if (modelMapCache) return modelMapCache;
  try {
    const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
    const resp = await fetch(`${TRPC_BASE}flow.projectInitialData?input=${input}`, {
      method: 'GET',
      headers: { accept: '*/*' },
      credentials: 'include',
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    const families: Array<Record<string, unknown>> =
      data?.result?.data?.json?.modelConfig?.imageModelFamilies ?? [];
    const map: Record<string, string> = {};
    for (const f of families) {
      const id = f.id as string | undefined;
      const usages = f.usages as Array<Record<string, unknown>> | undefined;
      const key = usages?.[0]?.key as string | undefined;
      console.log(`[FlowGen] image model family: ${f.displayName} id=${id} key=${key}`);
      if (id && key) map[id] = key;
    }
    if (Object.keys(map).length) modelMapCache = map;
    return map;
  } catch {
    return {};
  }
}

/** GET media.getMediaUrlRedirect?name=<id> → the image's GCS `location`. */
export async function resolveMediaLocation(mediaId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${TRPC_BASE}media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}`, {
      method: 'GET',
      headers: { accept: '*/*' },
      credentials: 'include',
    });
    // The redirect was followed to the signed CDN asset (flow-content.google /
    // storage.googleapis.com / …) — that final URL is the displayable link.
    if (resp.redirected && /^https:\/\//.test(resp.url)) return resp.url;
    if (!resp.ok) return null;
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
  const workflowId =
    (m.workflowId as string | undefined) || (gen?.workflowId as string | undefined);

  return {
    mediaId,
    type,
    prompt,
    model,
    aspectRatio,
    workflowId,
    url,
    width: dims?.width,
    height: dims?.height,
  };
}

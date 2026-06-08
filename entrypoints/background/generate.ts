/**
 * Direct Flow generation — the panel drives labs.google itself (no agent).
 *
 * Strategy: we never hand-author Google's request schema. Instead the live
 * page's fetch hook captures a *real* generation request body the first time
 * the user generates on the Flow UI. The panel then replays that template with
 * a handful of fields overridden (prompt / model / orientation / count) and an
 * auto-retry loop wrapped around captcha + submit + (for video) polling.
 */

import { state } from './state';
import { solveCaptcha } from './captcha';
import { resolveMediaLocation } from './project-media';
import { classifyApiUrl, startLogEntry, markLogSuccess, markLogFailed } from './log';
import type {
  GenTemplates,
  GenTemplate,
  GenerateParams,
  GenProgress,
  GenResult,
  GenResultMedia,
  MediaKind,
  Orientation,
  RefImage,
} from './types';

const TEMPLATES_KEY = 'genTemplates';
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TICKS = 60; // ~4 min ceiling per attempt
const GCS_URL_RE =
  /https:\/\/storage\.googleapis\.com\/[A-Za-z0-9._-]+\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\\\s]+/g;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Headers the browser controls — must not be replayed from the template.
const FORBIDDEN_HEADERS = new Set([
  'host', 'cookie', 'referer', 'origin', 'user-agent', 'content-length',
  'connection', 'accept-encoding', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
]);

/**
 * Inject a fresh reCAPTCHA token everywhere it lives in the body. The captured
 * template embeds the ORIGINAL (now-stale) token; if we fail to overwrite it the
 * server replies "reCAPTCHA evaluation failed / UNUSUAL_ACTIVITY". So we deep-walk
 * and replace any recaptcha token field, returning a count for diagnostics.
 */
function injectCaptchaToken(body: unknown, token: string): unknown {
  const cloned = JSON.parse(JSON.stringify(body));
  let count = 0;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      const k = key.toLowerCase();
      // 1) a recaptchaContext object → set its .token
      if (k === 'recaptchacontext' && val && typeof val === 'object') {
        (val as Record<string, unknown>).token = token;
        count++;
        continue;
      }
      // 2) a string field that clearly holds a recaptcha/captcha token
      if (typeof val === 'string' && (/recaptcha.*token|captcha.*token|recaptchatoken/.test(k) || (k === 'token' && 'recaptchaContext' in obj))) {
        obj[key] = token;
        count++;
        continue;
      }
      if (typeof val === 'object') visit(val);
    }
  };
  visit(cloned);
  console.log(`[FlowGen] captcha token injected into ${count} field(s)`);
  if (count === 0) console.warn('[FlowGen] ⚠ no recaptcha field found — body still carries the STALE token. Body keys:', Object.keys((cloned ?? {}) as object));
  return cloned;
}

// ─── Template storage ─────────────────────────────────────────

let templates: GenTemplates = {};

export async function loadTemplates(): Promise<void> {
  const data = await chrome.storage.local.get(TEMPLATES_KEY);
  if (data[TEMPLATES_KEY] && typeof data[TEMPLATES_KEY] === 'object') {
    templates = data[TEMPLATES_KEY] as GenTemplates;
  }
}

export function getTemplates(): GenTemplates {
  return templates;
}

/** Called when the live page emits a captured generation request. */
export async function recordTemplate(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<void> {
  const kind = templateKindForUrl(url);
  if (!kind) return;
  templates[kind] = { url, body, headers, capturedAt: Date.now() };
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
  console.log(`[FlowGen] Captured ${kind} template from`, url);
  chrome.runtime.sendMessage({ type: 'GEN_TEMPLATES_UPDATE', templates }).catch(() => {});
}

function templateKindForUrl(url: string): keyof GenTemplates | null {
  const t = classifyApiUrl(url);
  if (t === 'GEN_IMG') return 'image';
  if (t === 'GEN_VID') return 'video';
  if (t === 'GEN_VID_REF') return 'videoRef';
  if (t === 'POLL') return 'videoPoll';
  if (t === 'UPLOAD') return 'upload';
  return null;
}

// ─── Field overrides (heuristic, logged) ──────────────────────

const ORIENT_TOKENS: Record<Orientation, string> = {
  landscape: 'LANDSCAPE',
  portrait: 'PORTRAIT',
  square: 'SQUARE',
};
const ORIENT_RATIOS: Record<Orientation, string> = {
  landscape: '16:9',
  portrait: '9:16',
  square: '1:1',
};

function swapOrientation(value: string, orient: Orientation): string {
  // Token form, e.g. IMAGE_ASPECT_RATIO_LANDSCAPE → ..._PORTRAIT
  if (/LANDSCAPE|PORTRAIT|SQUARE/.test(value)) {
    return value.replace(/LANDSCAPE|PORTRAIT|SQUARE/, ORIENT_TOKENS[orient]);
  }
  // Ratio form, e.g. 16:9 → 9:16
  if (/^\d{1,2}:\d{1,2}$/.test(value)) return ORIENT_RATIOS[orient];
  return value;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function newUuid(): string {
  return crypto.randomUUID();
}

/** Stringify a request body for logging with long token/base64 fields blanked,
 *  so the meaningful fields are actually visible. */
function redactForLog(body: unknown): string {
  const clone = JSON.parse(JSON.stringify(body));
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.length > 80) o[k] = `<${v.length} chars>`;
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(clone);
  return JSON.stringify(clone, null, 1).slice(0, 1500);
}

/**
 * Deep-clone the template body and override the real Flow generation fields,
 * confirmed against a captured batchGenerateImages request:
 *   imageModelName · imageAspectRatio · structuredPrompt.parts[].text ·
 *   clientContext.{workflowId,projectId} · mediaGenerationContext.batchId · seed
 * Stale identifiers (workflowId/batchId/seed) are refreshed so the request binds
 * to the current workflow and doesn't collide with the captured one.
 */
function applyOverrides(body: unknown, p: GenerateParams): unknown {
  const cloned = JSON.parse(JSON.stringify(body));
  const changes: string[] = [];
  const batchId = newUuid();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      const k = key.toLowerCase();
      if (typeof val === 'string') {
        if (k === 'imagemodelname' || (k.includes('model') && /name|key/.test(k))) {
          if (p.model) { obj[key] = p.model; changes.push(`${key}=${p.model}`); }
        } else if (/aspect|orientation/.test(k) && p.orientation) {
          const next = swapOrientation(val, p.orientation);
          if (next !== val) { obj[key] = next; changes.push(`${key}=${next}`); }
        } else if (/prompt|^text$|caption|userinput/.test(k) && p.prompt) {
          obj[key] = p.prompt;
          changes.push(`${key}=<prompt>`);
        } else if (k === 'workflowid' && p.workflowId) {
          obj[key] = p.workflowId; changes.push('workflowId↻');
        } else if (k === 'projectid' && p.projectId) {
          obj[key] = p.projectId;
        } else if (k === 'batchid') {
          obj[key] = batchId; changes.push('batchId↻');
        }
      } else if (typeof val === 'number') {
        if (k === 'seed') { obj[key] = randomSeed(); changes.push('seed↻'); }
      } else {
        visit(val);
      }
    }
  };
  visit(cloned);

  // Quantity: Flow batches one entry per image in requests[]. Duplicate the
  // first request with a fresh seed for each extra image requested.
  const reqs = (cloned as { requests?: unknown[] }).requests;
  if (Array.isArray(reqs) && reqs.length && p.count && p.count > 1) {
    const base = reqs[0];
    for (let i = 1; i < p.count; i++) {
      const copy = JSON.parse(JSON.stringify(base));
      reseed(copy);
      reqs.push(copy);
    }
    changes.push(`count=${p.count}`);
  }

  console.log('[FlowGen] overrides:', changes.length ? changes.join(', ') : '(none — verify field names)');
  return cloned;
}

function reseed(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (key.toLowerCase() === 'seed' && typeof val === 'number') obj[key] = randomSeed();
    else if (typeof val === 'object') reseed(val);
  }
}

// ─── Reference images (upload + project) ──────────────────────

/** A resolved reference: the native handle Flow uses to attach an image. */
interface RefHandle {
  mediaId?: string;
  url?: string;
  raw?: unknown; // upload response, for unknown schemas
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The image-gen response carries generated media as ids (uuids), not URLs.
 * Resolve those ids to displayable links via getMediaUrlRedirect — excluding the
 * ids we already know (project/workflow/refs) so we only fetch real outputs.
 */
async function resolveResultMedia(
  responseText: string,
  exclude: Set<string>,
): Promise<GenResultMedia[]> {
  const ids = [...new Set(responseText.match(UUID_G) ?? [])].filter((id) => !exclude.has(id));
  const out: GenResultMedia[] = [];
  for (let i = 0; i < ids.length; i += 6) {
    const batch = ids.slice(i, i + 6);
    const urls = await Promise.all(batch.map((id) => resolveMediaLocation(id)));
    urls.forEach((url) => {
      if (url) out.push({ type: url.includes('/video/') ? 'video' : 'image', url });
    });
  }
  return out;
}

/** Upload one base64 image via the captured upload template; parse a handle.
 *  Throws with a specific reason on failure so the panel can show why. */
async function uploadRef(ref: RefImage): Promise<RefHandle> {
  const tpl = templates.upload;
  if (!tpl) {
    throw new Error('NO_UPLOAD_TEMPLATE: chưa học request uploadImage — hãy upload 1 ảnh ref trên Flow UI một lần');
  }
  if (!ref.base64) throw new Error('REF_NO_DATA');
  // Swap the image bytes into the template by key-name heuristic.
  const body = JSON.parse(JSON.stringify(tpl.body));
  let injected = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if (typeof val === 'string' && /image|bytes|content|data|raw|base64|b64/.test(k) && val.length > 64) {
        (node as Record<string, unknown>)[key] = ref.base64;
        injected = true;
      } else if (typeof val === 'object') visit(val);
    }
  };
  visit(body);
  if (!injected) console.warn('[FlowGen] upload: could not find image-bytes field in template');

  const res = await submit(tpl.url, body, tpl.headers);
  if (!res.ok) {
    throw new Error(`UPLOAD_${res.status}: ${res.text.slice(0, 120)}`);
  }
  const id = res.text.match(UUID_RE)?.[0];
  const url = (res.text.match(GCS_URL_RE)?.[0] || '').replace(/\\u0026/g, '&').replace(/\\/g, '');
  let raw: unknown = res.text;
  try {
    raw = JSON.parse(res.text);
  } catch {
    /* keep text */
  }
  console.log('[FlowGen] uploaded ref →', { id, url: url || undefined });
  return { mediaId: id, url: url || undefined, raw };
}

async function resolveReferences(
  refs: RefImage[],
  progress: (phase: GenProgress['phase'], message: string) => void,
): Promise<{ handles: RefHandle[]; errors: string[] }> {
  const handles: RefHandle[] = [];
  const errors: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    if (ref.source === 'project') {
      handles.push({ mediaId: ref.mediaId, url: ref.url });
    } else {
      progress('submit', `Upload ảnh ref ${i + 1}/${refs.length}…`);
      try {
        handles.push(await uploadRef(ref));
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(msg);
        console.error(`[FlowGen] ref ${i + 1} upload failed:`, msg);
      }
    }
  }
  return { handles, errors };
}

/**
 * Inject reference handles into a generation body. Prefers cloning an existing
 * reference-entry shape found in the template; otherwise inserts a best-effort
 * entry. Logged so the real shape can be confirmed from captured payloads.
 */
function injectReferences(body: unknown, handles: RefHandle[]): void {
  if (!handles.length) return;

  // Find an array under a key that looks like a reference/ingredient list.
  const holder: { arr: unknown[] | null } = { arr: null };
  const find = (node: unknown): void => {
    if (holder.arr) return;
    if (Array.isArray(node)) return node.forEach(find);
    if (!node || typeof node !== 'object') return;
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(val) && /reference|ingredient|refimage|mediainput|inputimage|imageinput/i.test(key)) {
        holder.arr = val;
        return;
      }
      if (typeof val === 'object') find(val);
    }
  };
  find(body);
  const target = holder.arr;

  const sample = target && target.length ? target[0] : null;
  const entries = handles.map((h) => {
    if (sample) {
      const entry = JSON.parse(JSON.stringify(sample));
      // overwrite id-like / url-like fields with this handle
      const patch = (n: unknown): void => {
        if (!n || typeof n !== 'object') return;
        for (const [key, val] of Object.entries(n as Record<string, unknown>)) {
          const k = key.toLowerCase();
          if (typeof val === 'string') {
            if (/id|mediaid|name/.test(k) && h.mediaId) (n as Record<string, unknown>)[key] = h.mediaId;
            else if (/url|uri/.test(k) && h.url) (n as Record<string, unknown>)[key] = h.url;
          } else if (typeof val === 'object') patch(val);
        }
      };
      patch(entry);
      return entry;
    }
    // Real Flow shape (confirmed): imageInputs[] = { imageInputType, name }
    return { imageInputType: 'IMAGE_INPUT_TYPE_BASE_IMAGE', name: h.mediaId };
  });

  if (target) {
    target.length = 0;
    target.push(...entries);
    console.log(`[FlowGen] injected ${entries.length} references into existing array`);
    return;
  }

  // No reference array in the template (captured without refs): add imageInputs
  // to each request entry, which is where Flow expects them.
  const reqs = (body as { requests?: unknown[] }).requests;
  if (Array.isArray(reqs) && reqs.length) {
    for (const r of reqs) {
      if (r && typeof r === 'object') (r as Record<string, unknown>).imageInputs = JSON.parse(JSON.stringify(entries));
    }
    console.log(`[FlowGen] injected ${entries.length} references as requests[].imageInputs`);
  } else {
    (body as Record<string, unknown>).imageInputs = entries;
    console.warn('[FlowGen] no requests[] — attached imageInputs at top level (verify schema)');
  }
}

function pickTemplate(kind: MediaKind, hasRefs: boolean): GenTemplate | undefined {
  // Image: we know the real schema — build it from scratch (no capture needed).
  if (kind === 'image') return templates.image ?? defaultImageTemplate();
  // Video: schema not yet hardcoded — rely on a captured template.
  if (hasRefs && templates.videoRef) return templates.videoRef;
  return templates.video;
}

/**
 * Built-in batchGenerateImages template, reconstructed from a real captured
 * request. All dynamic fields are placeholders that applyOverrides /
 * injectReferences / injectCaptchaToken fill in (model, prompt, aspectRatio,
 * workflowId, projectId, batchId, seed, recaptcha token, imageInputs).
 */
function defaultImageTemplate(): GenTemplate {
  const clientContext = () => ({
    recaptchaContext: { token: '', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
    projectId: '',
    tool: 'PINHOLE',
    workflowId: '',
    sessionId: `;${Date.now()}`,
  });
  return {
    url: 'https://aisandbox-pa.googleapis.com/v1/projects/PROJECT_ID/flowMedia:batchGenerateImages',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: {
      clientContext: clientContext(),
      mediaGenerationContext: { batchId: '' },
      useNewMedia: true,
      requests: [
        {
          clientContext: clientContext(),
          imageModelName: 'nano_banana_pro',
          imageAspectRatio: 'IMAGE_ASPECT_RATIO_PORTRAIT',
          structuredPrompt: { parts: [{ text: '' }] },
          seed: 0,
        },
      ],
    },
    capturedAt: 0,
  };
}

/** Force the real projectId into the request URL (templates may be stale). */
function withProjectId(url: string, projectId?: string): string {
  if (!projectId) return url;
  return url.replace(/\/projects\/[^/]+\//, `/projects/${projectId}/`);
}

// ─── Result extraction (best-effort, schema-agnostic) ─────────

function extractMedia(responseText: string, kind: MediaKind): GenResultMedia[] {
  const media: GenResultMedia[] = [];
  const seen = new Set<string>();

  const urls = responseText.match(GCS_URL_RE) ?? [];
  for (const raw of urls) {
    const url = raw.replace(/\\u0026/g, '&').replace(/\\/g, '');
    if (seen.has(url)) continue;
    seen.add(url);
    const type: MediaKind = url.includes('/video/') ? 'video' : 'image';
    media.push({ type, url });
  }

  // Inline base64 fallback (image responses sometimes embed bytes)
  if (!media.length && kind === 'image') {
    try {
      const data = JSON.parse(responseText);
      collectBase64(data, media, seen);
    } catch {
      /* not JSON — ignore */
    }
  }
  return media;
}

function collectBase64(node: unknown, out: GenResultMedia[], seen: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectBase64(n, out, seen));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (
      typeof val === 'string' &&
      val.length > 256 &&
      /image|bytes|encoded|b64|base64/.test(k) &&
      /^[A-Za-z0-9+/=]+$/.test(val.slice(0, 64))
    ) {
      if (seen.has(val.slice(0, 64))) continue;
      seen.add(val.slice(0, 64));
      out.push({ type: 'image', dataUri: `data:image/png;base64,${val}` });
    } else if (typeof val === 'object') {
      collectBase64(val, out, seen);
    }
  }
}

// ─── Failure classification → retry decision ──────────────────

type Attempt =
  | { kind: 'ok'; media: GenResultMedia[]; raw: string }
  | { kind: 'empty'; raw: string } // request fine but no media — do NOT retry
  | { kind: 'token'; error: string } // 401 — refresh then retry
  | { kind: 'session'; error: string } // 403 — reload Flow tab + re-sync token, then retry
  | { kind: 'blocked'; error: string } // safety block — deterministic, do NOT retry
  | { kind: 'retry'; error: string }; // captcha/4xx/5xx — backoff + retry

// ─── Core engine ──────────────────────────────────────────────

interface RunDeps {
  onProgress: (p: GenProgress) => void;
  refreshToken: () => Promise<void>;
  /** Hard session recovery: reload the Flow tab and re-sync the bearer token. */
  reloadFlowTab: () => Promise<void>;
}

export async function runGenerate(
  runId: string,
  params: GenerateParams,
  deps: RunDeps,
): Promise<GenResult> {
  const kind = params.mediaType;
  const refs = params.references ?? [];
  const hasRefs = refs.length > 0;
  const template = pickTemplate(kind, hasRefs);
  if (!template) {
    const want = kind === 'video' && hasRefs ? 'videoRef' : kind;
    return {
      runId,
      ok: false,
      media: [],
      attempts: 0,
      error:
        `NO_TEMPLATE: chưa capture được request ${want}. Hãy generate 1 lần (loại tương ứng) trên Flow UI để extension học request mẫu.`,
    };
  }

  const max = Math.max(1, params.maxAttempts || 1);
  const captchaAction = kind === 'image' ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
  const submitUrl = withProjectId(template.url, params.projectId);
  let lastError = 'UNKNOWN';
  let lastRaw: string | undefined;
  // Count 403s across attempts. A single 403 is often transient (stale captcha
  // binding) and clears on a retry with a fresh captcha — so we DON'T reload the
  // Flow tab mid-run (that disrupts the session and causes the next 403). Only if
  // EVERY attempt 403s do we hard-recover (reload tab + re-sync token) afterwards.
  let count403 = 0;

  // Resolve reference images once (upload new files, pass through project ones).
  let refHandles: RefHandle[] = [];
  if (hasRefs) {
    const resolved = await resolveReferences(refs, (phase, message) =>
      deps.onProgress({ runId, attempt: 0, maxAttempts: max, phase, message }),
    );
    refHandles = resolved.handles;
    if (!refHandles.length) {
      return {
        runId,
        ok: false,
        media: [],
        attempts: 0,
        error: resolved.errors[0] || 'REF_UPLOAD_FAILED',
      };
    }
  }

  // One full attempt: fresh captcha → submit → classify. Returns a terminal
  // GenResult (success / safety-block) or null to signal "retry".
  const attemptOnce = async (attempt: number, label: string): Promise<GenResult | null> => {
    const progress = (phase: GenProgress['phase'], message: string) =>
      deps.onProgress({ runId, attempt, maxAttempts: max, phase, message });

    const logId = `${runId}-a${attempt}`;
    startLogEntry(logId, submitUrl, undefined);

    try {
      // 1) Fresh captcha each attempt (single-use token)
      progress('captcha', `Attempt ${label} — giải captcha…`);
      const cap = await solveCaptcha(logId, captchaAction);
      if (!cap?.token) {
        lastError = `CAPTCHA_FAILED: ${cap?.error ?? 'no token'}`;
        markLogFailed(logId, lastError);
        await backoff(attempt, 429, progress);
        return null;
      }

      // 2) Build + submit
      progress('submit', `Attempt ${label} — gửi request…`);
      const overridden = applyOverrides(template.body, params);
      if (refHandles.length) injectReferences(overridden, refHandles);
      const body = injectCaptchaToken(overridden, cap.token);
      const res = await submit(submitUrl, body, template.headers);
      lastRaw = res.text.slice(0, 2000);

      const outcome = classify(res, kind);
      if (outcome.kind === 'ok') {
        markLogSuccess(logId, res.status, res.text.slice(0, 300), outcome.media);
        progress('done', `Hoàn tất sau ${attempt} lần thử — ${outcome.media.length} media.`);
        return { runId, ok: true, media: outcome.media, attempts: attempt, rawResponse: res.text.slice(0, 2000) };
      }
      if (outcome.kind === 'empty') {
        // For video, an "empty" submit means we got an operation to poll.
        if (kind === 'video') {
          progress('poll', `Attempt ${label} — chờ video render…`);
          const polled = await pollVideo(res.text, progress);
          if (polled.length) {
            markLogSuccess(logId, res.status, 'video ready', polled);
            progress('done', `Video xong sau ${attempt} lần thử.`);
            return { runId, ok: true, media: polled, attempts: attempt, rawResponse: res.text.slice(0, 2000) };
          }
          lastError = 'VIDEO_POLL_TIMEOUT';
          markLogFailed(logId, lastError);
          await backoff(attempt, res.status, progress);
          return null;
        }
        // Image: the response carries generated media as ids — resolve to URLs.
        const exclude = new Set<string>(
          [params.projectId, params.workflowId, ...refHandles.map((h) => h.mediaId)].filter(
            (x): x is string => !!x,
          ),
        );
        const resolved = await resolveResultMedia(res.text, exclude);
        if (resolved.length) {
          markLogSuccess(logId, res.status, `${resolved.length} media`, resolved);
          progress('done', `Hoàn tất sau ${attempt} lần thử — ${resolved.length} ảnh.`);
          return { runId, ok: true, media: resolved, attempts: attempt, rawResponse: res.text.slice(0, 2000) };
        }
        console.warn('[FlowGen] response had no resolvable media:\n', res.text.slice(0, 1500));
        markLogSuccess(logId, res.status, res.text.slice(0, 300));
        progress('done', 'Request OK nhưng không có media (có thể bị safety-block).');
        return { runId, ok: true, media: [], attempts: attempt, rawResponse: res.text.slice(0, 2000) };
      }
      if (outcome.kind === 'blocked') {
        // Deterministic safety rejection — retrying wastes captcha solves.
        markLogFailed(logId, outcome.error, res.status, res.text.slice(0, 300));
        progress('error', 'Google chặn vì nội dung không an toàn — đổi prompt khác.');
        return {
          runId,
          ok: false,
          media: [],
          attempts: attempt,
          error: outcome.error,
          rawResponse: res.text.slice(0, 2000),
        };
      }
      if (outcome.kind === 'token') {
        lastError = outcome.error;
        markLogFailed(logId, lastError, res.status);
        progress('retry', `Token hết hạn — refresh rồi thử lại…`);
        await deps.refreshToken();
        return null;
      }
      if (outcome.kind === 'session') {
        // 403 — retry in-tab with a fresh captcha (no reload here).
        count403 += 1;
        lastError = outcome.error;
        markLogFailed(logId, lastError, res.status, res.text.slice(0, 300));
        progress('retry', `Lỗi 403 (lần ${count403}) — thử lại với captcha mới…`);
        await backoff(attempt, 403, progress);
        return null;
      }
      // retry kind
      lastError = outcome.error;
      markLogFailed(logId, lastError, res.status, res.text.slice(0, 300));
      await backoff(attempt, res.status, progress);
      return null;
    } catch (e) {
      lastError = (e as Error).message || 'GENERATE_FAILED';
      markLogFailed(logId, lastError);
      await backoff(attempt, 0, progress);
      return null;
    }
  };

  // Main attempt budget.
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await attemptOnce(attempt, `${attempt}/${max}`);
    if (result) return result;
  }

  // Every attempt 403'd → the Flow session is stale. In batch parallel mode we
  // must NOT reload the shared Flow tab (it would break sibling rows) — just fail
  // this row so the user can re-run it individually (which does the full recovery).
  if (lastError === 'API_403' && count403 >= max && params.noReload) {
    return {
      runId,
      ok: false,
      media: [],
      attempts: max,
      error: 'API_403: 3 lần đều 403 (batch — bỏ qua reload tab). Bấm ↻ chạy lại riêng row này để reload Flow & sync token.',
      rawResponse: lastRaw,
    };
  }
  // Otherwise hard-recover (reload tab + re-sync token), then give it ONE more
  // shot. Still 403 → stop.
  if (lastError === 'API_403' && count403 >= max) {
    deps.onProgress({ runId, attempt: max, maxAttempts: max, phase: 'retry', message: `${max} lần đều 403 — reload tab Flow & sync lại token, thử lại lần cuối…` });
    await deps.reloadFlowTab();
    count403 = 0;
    const result = await attemptOnce(max + 1, 'sau reload');
    if (result) return result;
    return {
      runId,
      ok: false,
      media: [],
      attempts: max + 1,
      error:
        count403 > 0
          ? 'API_403: vẫn 403 sau khi reload tab & sync token — dừng. Mở lại Flow và đăng nhập lại.'
          : lastError,
      rawResponse: lastRaw,
    };
  }
  return { runId, ok: false, media: [], attempts: max, error: lastError, rawResponse: lastRaw };
}

// ─── helpers ──────────────────────────────────────────────────

interface SubmitResult {
  status: number;
  ok: boolean;
  text: string;
}

async function submit(
  url: string,
  body: unknown,
  tplHeaders?: Record<string, string>,
): Promise<SubmitResult> {
  const flowKey = state.flowKey;
  if (!flowKey) return { status: 401, ok: false, text: 'NO_FLOW_KEY' };

  // Replay the page's real headers (e.g. text/plain content-type, x-goog-*),
  // dropping the ones the browser owns; then force our captured bearer token.
  const headers: Record<string, string> = {};
  if (tplHeaders) {
    for (const [k, v] of Object.entries(tplHeaders)) {
      if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  headers['authorization'] = `Bearer ${flowKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (resp.ok) {
    // A 2xx proves the bearer token is still valid right now — keep the
    // freshness clock honest so the panel doesn't falsely show "expired"
    // while generation is clearly working.
    state.metrics.tokenCapturedAt = Date.now();
  }
  if (!resp.ok) {
    console.error(`[FlowGen] submit ${resp.status} ${url}\n`, text.slice(0, 600));
    console.error('[FlowGen] request body sent (token redacted):\n', redactForLog(body));
  }
  return { status: resp.status, ok: resp.ok, text };
}

function classify(res: SubmitResult, kind: MediaKind): Attempt {
  if (res.status === 401 || /unauthenticated|token expired|invalid.*credential/i.test(res.text)) {
    return { kind: 'token', error: `TOKEN_${res.status}` };
  }
  if (!res.ok) {
    if (/UNSAFE_GENERATION|UNSAFE_|SENSITIVE|safety|blocked|policy/i.test(res.text)) {
      return { kind: 'blocked', error: 'UNSAFE_GENERATION: prompt bị Google chặn vì nội dung không an toàn' };
    }
    if (res.status === 403) {
      // Forbidden — stale session / invalid recaptcha binding. Reload Flow + resync.
      return { kind: 'session', error: 'API_403' };
    }
    return { kind: 'retry', error: `API_${res.status}` };
  }
  const media = extractMedia(res.text, kind);
  if (media.length) return { kind: 'ok', media, raw: res.text };
  return { kind: 'empty', raw: res.text };
}

async function pollVideo(
  submitText: string,
  progress: (phase: GenProgress['phase'], message: string) => void,
): Promise<GenResultMedia[]> {
  const poll = templates.videoPoll;
  if (!poll) {
    // No poll template captured — best we can do is scan the submit response.
    return extractMedia(submitText, 'video');
  }
  for (let tick = 0; tick < POLL_MAX_TICKS; tick++) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await submit(poll.url, poll.body, poll.headers);
      const media = extractMedia(res.text, 'video');
      if (media.length) return media;
    } catch {
      /* keep polling */
    }
    progress('poll', `Đang render video… (${tick + 1})`);
  }
  return [];
}

async function backoff(
  attempt: number,
  status: number,
  progress: (phase: GenProgress['phase'], message: string) => void,
): Promise<void> {
  // Exponential 1s→2s→4s…, longer floor for quota (429).
  const base = status === 429 ? 5000 : 1000;
  const wait = Math.min(base * 2 ** (attempt - 1), 30_000);
  progress('retry', `Chờ ${Math.round(wait / 1000)}s rồi thử lại…`);
  await sleep(wait);
}

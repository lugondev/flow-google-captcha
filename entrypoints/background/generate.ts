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

/**
 * Deep-clone the template body and override known dynamic fields by key name.
 * Conservative: only touches keys whose names clearly map to a field, and logs
 * every change so the mapping can be verified against real payloads.
 */
function applyOverrides(body: unknown, p: GenerateParams): unknown {
  const cloned = JSON.parse(JSON.stringify(body));
  const changes: string[] = [];

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
        if (/prompt|^text$|caption|userinput/.test(k) && p.prompt) {
          obj[key] = p.prompt;
          changes.push(`${key}=<prompt>`);
        } else if (/aspect|orientation/.test(k) && p.orientation) {
          const next = swapOrientation(val, p.orientation);
          if (next !== val) {
            obj[key] = next;
            changes.push(`${key}=${next}`);
          }
        } else if (k.includes('model') && p.model) {
          obj[key] = p.model;
          changes.push(`${key}=${p.model}`);
        }
      } else if (typeof val === 'number') {
        if (/samplecount|imagecount|mediacount|numimages|samples/.test(k) && p.count) {
          obj[key] = p.count;
          changes.push(`${key}=${p.count}`);
        }
      } else {
        visit(val);
      }
    }
  };

  visit(cloned);
  console.log('[FlowGen] overrides applied:', changes.length ? changes.join(', ') : '(none — verify template field names)');
  return cloned;
}

// ─── Reference images (upload + project) ──────────────────────

/** A resolved reference: the native handle Flow uses to attach an image. */
interface RefHandle {
  mediaId?: string;
  url?: string;
  raw?: unknown; // upload response, for unknown schemas
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

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
    return { mediaId: h.mediaId, url: h.url };
  });

  if (target) {
    target.length = 0;
    target.push(...entries);
    console.log(`[FlowGen] injected ${entries.length} references into existing array`);
  } else {
    (body as Record<string, unknown>).referenceImages = entries;
    console.warn('[FlowGen] no reference array in template — attached as body.referenceImages (verify schema)');
  }
}

function pickTemplate(kind: MediaKind, hasRefs: boolean): GenTemplate | undefined {
  if (kind === 'video' && hasRefs && templates.videoRef) return templates.videoRef;
  return templates[kind];
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
  | { kind: 'blocked'; error: string } // safety block — deterministic, do NOT retry
  | { kind: 'retry'; error: string }; // captcha/4xx/5xx — backoff + retry

// ─── Core engine ──────────────────────────────────────────────

interface RunDeps {
  onProgress: (p: GenProgress) => void;
  refreshToken: () => Promise<void>;
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
  let lastError = 'UNKNOWN';
  let lastRaw: string | undefined;

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

  for (let attempt = 1; attempt <= max; attempt++) {
    const progress = (phase: GenProgress['phase'], message: string) =>
      deps.onProgress({ runId, attempt, maxAttempts: max, phase, message });

    const logId = `${runId}-a${attempt}`;
    startLogEntry(logId, template.url, undefined);

    try {
      // 1) Fresh captcha each attempt (single-use token)
      progress('captcha', `Attempt ${attempt}/${max} — giải captcha…`);
      const cap = await solveCaptcha(logId, captchaAction);
      if (!cap?.token) {
        lastError = `CAPTCHA_FAILED: ${cap?.error ?? 'no token'}`;
        markLogFailed(logId, lastError);
        await backoff(attempt, 429, progress);
        continue;
      }

      // 2) Build + submit
      progress('submit', `Attempt ${attempt}/${max} — gửi request…`);
      const overridden = applyOverrides(template.body, params);
      if (refHandles.length) injectReferences(overridden, refHandles);
      const body = injectCaptchaToken(overridden, cap.token);
      const res = await submit(template.url, body, template.headers);
      lastRaw = res.text.slice(0, 2000);

      const outcome = classify(res, kind);
      if (outcome.kind === 'ok') {
        markLogSuccess(logId, res.status, res.text.slice(0, 300));
        progress('done', `Hoàn tất sau ${attempt} lần thử — ${outcome.media.length} media.`);
        return { runId, ok: true, media: outcome.media, attempts: attempt, rawResponse: res.text.slice(0, 2000) };
      }
      if (outcome.kind === 'empty') {
        // For video, an "empty" submit means we got an operation to poll.
        if (kind === 'video') {
          progress('poll', `Attempt ${attempt}/${max} — chờ video render…`);
          const polled = await pollVideo(res.text, progress);
          if (polled.length) {
            markLogSuccess(logId, res.status, 'video ready');
            progress('done', `Video xong sau ${attempt} lần thử.`);
            return { runId, ok: true, media: polled, attempts: attempt, rawResponse: res.text.slice(0, 2000) };
          }
          lastError = 'VIDEO_POLL_TIMEOUT';
          markLogFailed(logId, lastError);
          await backoff(attempt, res.status, progress);
          continue;
        }
        // Image with no media = blocked/empty → do not retry, surface raw.
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
        // token refresh does not consume the attempt budget aggressively;
        // we still advance the loop but without an extra backoff sleep.
        continue;
      }
      // retry kind
      lastError = outcome.error;
      markLogFailed(logId, lastError, res.status, res.text.slice(0, 300));
      await backoff(attempt, res.status, progress);
    } catch (e) {
      lastError = (e as Error).message || 'GENERATE_FAILED';
      markLogFailed(logId, lastError);
      await backoff(attempt, 0, progress);
    }
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
  if (!resp.ok) {
    console.error(`[FlowGen] submit ${resp.status} ${url}\n`, text.slice(0, 600));
    console.error('[FlowGen] request body sent:\n', JSON.stringify(body).slice(0, 1200));
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

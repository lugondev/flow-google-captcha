/**
 * Flow Helper — Background Service Worker Types
 */

export type AppState = 'off' | 'idle' | 'running';

export interface Metrics {
  tokenCapturedAt: number | null;
  requestCount: number;
  successCount: number;
  failedCount: number;
  lastError: string | null;
}

export type RequestLogStatus = 'processing' | 'success' | 'failed';

export interface RequestLogEntry {
  id: string;
  type: string;
  time: string;
  status: RequestLogStatus;
  error: string | null;
  outputUrl: string | null;
  /** Generated media for this request, shown inline on the log row when done. */
  outputs?: { type: 'image' | 'video'; url: string }[];
  url?: string;
  httpStatus?: number;
  payloadSummary?: string;
  responseSummary?: string;
}

export interface MediaUrlRef {
  mediaType: 'image' | 'video';
  url: string;
  mediaId: string;
}

// ─── Direct generation (panel → labs.google, no agent) ────────

export type MediaKind = 'image' | 'video';
export type Orientation = 'landscape' | 'portrait' | 'square';

/** A real Flow generation request captured from the live page, used as a
 *  template the panel replays with overridden fields. */
export interface GenTemplate {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  capturedAt: number;
}

export interface GenTemplates {
  image?: GenTemplate;
  video?: GenTemplate;
  videoRef?: GenTemplate; // video-from-reference-images (ReferenceImages endpoint)
  videoPoll?: GenTemplate;
  upload?: GenTemplate; // uploadImage endpoint
}

/** A reference image the user picked in the panel.
 *  - `upload`  : a new file read as base64 → uploaded via the upload template.
 *  - `project` : an image already in the Flow project (we have its URL/id). */
export interface RefImage {
  source: 'upload' | 'project';
  name?: string;
  mime?: string;
  base64?: string; // upload: raw base64 (no data: prefix)
  url?: string; // project: signed GCS url
  mediaId?: string; // project: media id
}

export interface GenerateParams {
  mediaType: MediaKind;
  prompt: string;
  model?: string;
  orientation?: Orientation;
  count?: number;
  maxAttempts: number;
  references?: RefImage[];
  projectId?: string; // from the Flow tab URL — bind request to current project
  workflowId?: string; // from /edit/<id> — bind request to current workflow
}

export interface GenResultMedia {
  type: MediaKind;
  url?: string; // GCS / signed URL
  dataUri?: string; // inline base64 fallback
}

export interface GenProgress {
  runId: string;
  attempt: number;
  maxAttempts: number;
  phase: 'captcha' | 'submit' | 'poll' | 'retry' | 'done' | 'error';
  message: string;
}

export interface GenResult {
  runId: string;
  ok: boolean;
  media: GenResultMedia[];
  error?: string;
  attempts: number;
  rawResponse?: string; // truncated, for debugging unknown schemas
}

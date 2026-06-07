/**
 * Shared display helpers for popup + side panel request logs.
 */

export const TYPE_LABELS: Record<string, string> = {
  // Worker request types
  GENERATE_IMAGE: 'GEN IMAGE',
  REGENERATE_IMAGE: 'REGEN IMAGE',
  EDIT_IMAGE: 'EDIT IMAGE',
  GENERATE_CHARACTER_IMAGE: 'GEN REF',
  REGENERATE_CHARACTER_IMAGE: 'REGEN REF',
  EDIT_CHARACTER_IMAGE: 'EDIT REF',
  GENERATE_VIDEO: 'GEN VIDEO',
  GENERATE_VIDEO_REFS: 'GEN VIDEO FROM REFS',
  UPSCALE_VIDEO: 'UPSCALE VIDEO',
  // Captcha action types
  IMAGE_GENERATION: 'GEN IMAGE',
  VIDEO_GENERATION: 'GEN VIDEO',
  // Extension-classified API types
  GEN_IMG: 'GEN IMAGE',
  GEN_VID: 'GEN VIDEO',
  GEN_VID_REF: 'GEN VIDEO FROM REFS',
  UPSCALE: 'UPSCALE VIDEO',
  UPS_IMG: 'UPSCALE IMAGE',
  POLL: 'CHECK GEN VIDEO',
  CREDITS: 'CHECK CREDIT',
  CREATE_PROJECT: 'CREATE PROJECT',
  UPLOAD: 'UPLOAD IMAGE',
  MEDIA: 'READ MEDIA',
  TRACKING: 'GOOGLE FLOW TRACK',
  URL_REFRESH: 'URL REFRESH',
  TRPC: 'TRPC',
  API: 'API',
};

export function formatType(type: string | undefined): string {
  if (!type) return '—';
  return TYPE_LABELS[type] ?? type.slice(0, 5).toUpperCase();
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  } catch {
    return '—';
  }
}

export function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function truncate(value: string, len: number): string {
  if (!value || value.length <= len) return value;
  return value.slice(0, len) + '…';
}

export function badgeHtml(status: string | number | undefined): string {
  if (status === 'COMPLETED' || status === 'success') {
    return '<span class="badge badge-ok">&#10003; done</span>';
  }
  if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
    return '<span class="badge badge-fail">&#10007; fail</span>';
  }
  if (status === 'PROCESSING') {
    return '<span class="badge badge-proc">&#9203; gen...</span>';
  }
  return '<span class="badge badge-proc">&#9203; sent</span>';
}

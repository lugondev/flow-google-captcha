/**
 * Side panel — connection status, metrics, request log with detail modal.
 * Styles live inline in `index.html`.
 */

import {
  badgeHtml,
  escHtml,
  formatTime,
  formatType,
  truncate,
} from '../../utils/log-display';
import { openMediaModal } from '../../utils/media-modal';

type LogStatus = string | number | undefined;

interface LogEntry {
  id: string;
  type?: string;
  method?: string;
  time?: string;
  timestamp?: string;
  createdAt?: string;
  status?: LogStatus;
  state?: string;
  error?: string | null;
  outputs?: { type: 'image' | 'video'; url: string }[];
  url?: string;
  httpStatus?: number;
  payloadSummary?: string;
  responseSummary?: string;
}

interface StatusData {
  state?: 'off' | 'idle' | 'running';
  flowKeyPresent?: boolean;
  hasFlowTab?: boolean;
  tokenAge?: number | null;
  metrics?: {
    requestCount?: number;
    successCount?: number;
    failedCount?: number;
    lastError?: string | null;
  };
}

function updateStatus(data: StatusData | null | undefined): void {
  if (!data) return;

  const tokenEl = document.getElementById('token-status');
  if (tokenEl) {
    if (data.flowKeyPresent) {
      const ageMs = data.tokenAge || 0;
      const ageMin = Math.round(ageMs / 60_000);
      if (ageMs > 3_600_000) {
        tokenEl.textContent = `token cũ ${ageMin}m — mở Flow để refresh`;
        tokenEl.className = 'warn';
      } else {
        tokenEl.textContent = `token synced ${ageMin}m`;
        tokenEl.className = 'ok';
      }
      if (ageMs > 3_300_000) {
        chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
      }
    } else {
      tokenEl.textContent = 'no token';
      tokenEl.className = 'bad';
    }
  }

  // Gate generation: need a Flow tab open (for captcha) AND a captured token.
  flowReady = !!(data.flowKeyPresent && data.hasFlowTab);
  reflectFlowReady(data);

  const m = data.metrics || {};
  const set = (id: string, v: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  set('m-total', m.requestCount || 0);
  set('m-success', m.successCount || 0);
  set('m-failed', m.failedCount || 0);
}

let flowReady = false;
let generating = false;

function flowBlockReason(data?: StatusData): string {
  if (data && !data.hasFlowTab) return 'Chưa mở tab Flow — bấm "Open Flow Tab".';
  if (data && !data.flowKeyPresent) return 'Chưa có token — mở Flow & đăng nhập.';
  return 'Cần mở tab Flow và có token hợp lệ.';
}

function reflectFlowReady(data?: StatusData): void {
  const btn = document.getElementById('btn-generate') as HTMLButtonElement | null;
  if (btn && !generating) btn.disabled = !flowReady;
  if (btn) btn.title = flowReady ? '' : flowBlockReason(data);
}

let _logEntries: LogEntry[] = [];

function updateRequestLog(entries: LogEntry[] | null | undefined): void {
  const tbody = document.getElementById('log-body');
  const countEl = document.getElementById('log-count');
  if (!tbody || !countEl) return;

  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No requests yet</td></tr>';
    countEl.textContent = '0';
    return;
  }

  countEl.textContent = String(entries.length);
  _logEntries = entries;

  tbody.innerHTML = entries
    .map((entry) => {
      const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
      const type = formatType(entry.type || entry.method);
      const time = formatTime(entry.time || entry.timestamp || entry.createdAt);
      const status = entry.status || entry.state || 'pending';
      const error = entry.error || '';
      const outputs = entry.outputs || [];

      let resultCell: string;
      if (status === 'success' && outputs.length) {
        const thumbs = outputs
          .slice(0, 3)
          .map((o) =>
            o.type === 'video'
              ? `<a class="log-vid" href="${escHtml(o.url)}" target="_blank" rel="noopener" title="Mở video">▶</a>`
              : `<a class="log-thumb" href="${escHtml(o.url)}" target="_blank" rel="noopener" title="Xem ảnh"><img src="${escHtml(o.url)}" loading="lazy" /></a>`,
          )
          .join('');
        const more = outputs.length > 3 ? `<span class="log-more">+${outputs.length - 3}</span>` : '';
        resultCell = `<td class="td-out">${thumbs}${more}</td>`;
      } else if (error) {
        resultCell = `<td class="td-error" title="${escHtml(error)}">${escHtml(truncate(error, 28))}</td>`;
      } else {
        resultCell = `<td class="td-error empty">—</td>`;
      }

      return `<tr>
        <td class="td-id" data-request-id="${escHtml(entry.id || '')}">${escHtml(shortId)}</td>
        <td class="td-type">${escHtml(type)}</td>
        <td class="td-time">${escHtml(time)}</td>
        <td>${badgeHtml(status)}</td>
        ${resultCell}
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll<HTMLElement>('.td-id[data-request-id]').forEach((td) => {
    td.addEventListener('click', () => {
      const reqId = td.getAttribute('data-request-id');
      if (reqId) showRequestDetail(reqId);
    });
  });
}

function showRequestDetail(reqId: string): void {
  const entry = _logEntries.find((e) => e.id === reqId);
  if (!entry) return;

  const overlay = document.getElementById('detail-overlay');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');
  if (!overlay || !title || !body) return;

  title.textContent = `Request ${String(reqId).slice(0, 12)}`;

  const fields: [string, unknown][] = [
    ['ID', entry.id],
    ['Type', formatType(entry.type || entry.method)],
    ['Time', formatTime(entry.time || entry.timestamp || entry.createdAt)],
    ['Status', entry.status || entry.state || 'pending'],
    ['HTTP', entry.httpStatus ?? '—'],
    ['URL', entry.url || '—'],
    ['Payload', entry.payloadSummary || '—'],
    ['Response', entry.responseSummary || '—'],
    ['Error', entry.error || '—'],
  ];

  body.innerHTML = fields
    .map(([label, value]) => {
      let cls = 'detail-value';
      if (label === 'Error' && value && value !== '—') cls += ' error';
      if (label === 'Status' && (value === 'COMPLETED' || value === 'success')) cls += ' ok';
      return `<div class="detail-row">
        <div class="detail-label">${escHtml(label)}</div>
        <div class="${cls}">${escHtml(String(value ?? '—'))}</div>
      </div>`;
    })
    .join('');

  overlay.classList.add('open');
}

document.getElementById('detail-close')?.addEventListener('click', () => {
  document.getElementById('detail-overlay')?.classList.remove('open');
});

document.getElementById('detail-overlay')?.addEventListener('click', (e) => {
  const target = e.currentTarget as HTMLElement | null;
  if (target && e.target === target) target.classList.remove('open');
});

function fetchStatus(): void {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError) return;
    updateStatus(data as StatusData);
  });
}

function fetchLog(): void {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG' }, (data) => {
    if (chrome.runtime.lastError) return;
    if (data && Array.isArray(data.log)) updateRequestLog(data.log as LogEntry[]);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATUS_PUSH') fetchStatus();
  if (msg?.type === 'REQUEST_LOG_UPDATE' && Array.isArray(msg.log)) {
    updateRequestLog(msg.log as LogEntry[]);
  }
  if (msg?.type === 'GEN_PROGRESS' && msg.progress) {
    const p = msg.progress as GenProgress;
    if (p.runId === activeRunId) setGenStatus(p.message, p.phase === 'error' ? 'err' : '');
  }
  if (msg?.type === 'GEN_TEMPLATES_UPDATE') refreshTemplateHint();
  // PROJECT_MEDIA_UPDATE (passive capture) no longer drives the picker —
  // the picker fetches authoritative data from the project API on open.
});

// ─── Generate panel ───────────────────────────────────────────

interface GenProgress {
  runId: string;
  attempt: number;
  maxAttempts: number;
  phase: string;
  message: string;
}
interface GenResultMedia {
  type: 'image' | 'video';
  url?: string;
  dataUri?: string;
}
interface GenResult {
  runId: string;
  ok: boolean;
  media: GenResultMedia[];
  error?: string;
  attempts: number;
  rawResponse?: string;
}

let genKind: 'image' | 'video' = 'image';
let genOrient: 'landscape' | 'portrait' | 'square' = 'portrait';
let activeRunId: string | null = null;

const FORM_KEY = 'genForm';

// ─── Reference images ─────────────────────────────────────────

interface PanelRef {
  source: 'upload' | 'project';
  name?: string;
  mime?: string;
  base64?: string;
  url?: string;
  mediaId?: string;
  thumb?: string; // data-uri or url for the thumbnail (project items may lack one)
}
interface ProjectMedia {
  mediaId: string;
  type: 'image' | 'video';
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  url?: string;
}

const MAX_REFS = 9;
let selectedRefs: PanelRef[] = [];

function renderRefStrip(): void {
  const strip = document.getElementById('ref-strip');
  if (!strip) return;
  strip.innerHTML = selectedRefs
    .map((r, i) => {
      const inner = r.thumb
        ? `<img src="${escHtml(r.thumb)}" />`
        : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:7px;padding:2px;color:var(--muted);text-align:center">${escHtml((r.name || r.mediaId || '').slice(0, 18))}</span>`;
      return `<div class="ref-thumb">
        ${inner}
        <span class="ref-x" data-ref-i="${i}">&times;</span>
        <span class="ref-src">${r.source === 'upload' ? 'up' : 'proj'}</span>
      </div>`;
    })
    .join('');
  strip.querySelectorAll<HTMLElement>('.ref-x').forEach((x) => {
    x.addEventListener('click', () => {
      const i = Number(x.getAttribute('data-ref-i'));
      selectedRefs.splice(i, 1);
      renderRefStrip();
      syncProjectSelection();
    });
  });
}

function fileToBase64(file: File): Promise<{ base64: string; dataUri: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result);
      const base64 = dataUri.split(',')[1] || '';
      resolve({ base64, dataUri });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addUploadFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    if (selectedRefs.length >= MAX_REFS) {
      setGenStatus(`Tối đa ${MAX_REFS} ảnh reference.`, 'err');
      break;
    }
    const { base64, dataUri } = await fileToBase64(file);
    selectedRefs.push({ source: 'upload', name: file.name, mime: file.type, base64, thumb: dataUri });
  }
  renderRefStrip();
}

function toggleProjectMedia(m: ProjectMedia): void {
  const idx = selectedRefs.findIndex((r) => r.source === 'project' && r.mediaId === m.mediaId);
  if (idx >= 0) selectedRefs.splice(idx, 1);
  else if (selectedRefs.length >= MAX_REFS) {
    setGenStatus(`Tối đa ${MAX_REFS} ảnh reference.`, 'err');
    return;
  } else
    selectedRefs.push({
      source: 'project',
      url: m.url,
      mediaId: m.mediaId,
      thumb: m.url,
      name: m.prompt || m.mediaId,
    });
  renderRefStrip();
  syncProjectSelection();
}

function syncProjectSelection(): void {
  document.querySelectorAll<HTMLElement>('.project-grid .pm').forEach((el) => {
    const id = el.getAttribute('data-media-id');
    el.classList.toggle('sel', selectedRefs.some((r) => r.source === 'project' && r.mediaId === id));
  });
}

function refreshProjectPicker(): void {
  const grid = document.getElementById('project-grid');
  if (grid) grid.innerHTML = '<div class="project-empty">Đang tải từ API…</div>';

  chrome.runtime.sendMessage({ type: 'GET_PROJECT_MEDIA' }, (data) => {
    if (!grid) return;
    if (chrome.runtime.lastError || !data) {
      grid.innerHTML = `<div class="project-empty">Lỗi: ${escHtml(chrome.runtime.lastError?.message || 'no data')}</div>`;
      return;
    }
    if (data.error) {
      grid.innerHTML = `<div class="project-empty">${escHtml(data.error)}</div>`;
      return;
    }
    const all = (data.media as ProjectMedia[]) || [];
    const imgCount = all.filter((m) => m.type === 'image').length;
    const vidCount = all.length - imgCount;

    if (!all.length) {
      grid.innerHTML = '<div class="project-empty">Project chưa có media nào đã lưu.</div>';
      return;
    }

    const scopeNote = data.scoped ? 'workflow hiện tại' : 'toàn project';
    grid.innerHTML =
      `<div class="project-empty" style="grid-column:1/-1">${all.length} media · ${scopeNote} (${imgCount} ảnh, ${vidCount} video) — bấm để chọn</div>` +
      all
        .map((m) => {
          const inner = m.url
            ? `<img src="${escHtml(m.url)}" loading="lazy" />`
            : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:7px;padding:2px;text-align:center;color:var(--muted)">${escHtml((m.prompt || m.mediaId).slice(0, 24))}</span>`;
          const badge = m.type === 'video' ? '<span style="position:absolute;bottom:0;left:0;right:0;font-size:7px;text-align:center;background:rgba(0,0,0,.6)">▶</span>' : '';
          return `<div class="pm" data-media-id="${escHtml(m.mediaId)}">${inner}${badge}</div>`;
        })
        .join('');
    grid.querySelectorAll<HTMLElement>('.pm').forEach((el) => {
      const id = el.getAttribute('data-media-id');
      const m = all.find((im) => im.mediaId === id);
      if (m) el.addEventListener('click', () => toggleProjectMedia(m));
    });
    syncProjectSelection();
  });
}

function initReferences(): void {
  document.getElementById('ref-upload-btn')?.addEventListener('click', () => {
    document.getElementById('ref-file')?.click();
  });
  document.getElementById('ref-file')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) void addUploadFiles(input.files);
    input.value = '';
  });
  document.getElementById('ref-project-btn')?.addEventListener('click', () => {
    const picker = document.getElementById('project-picker');
    if (!picker) return;
    picker.classList.toggle('show');
    if (picker.classList.contains('show')) refreshProjectPicker();
  });
}

function setGenStatus(text: string, cls: '' | 'err' | 'ok' = ''): void {
  const el = document.getElementById('gen-status');
  if (el) {
    el.textContent = text;
    el.className = `gen-status${cls ? ' ' + cls : ''}`;
  }
}

function refreshTemplateHint(): void {
  chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' }, (t) => {
    if (chrome.runtime.lastError || !t) return;
    const hint = document.getElementById('tpl-hint');
    if (!hint) return;
    if (genKind === 'image') {
      hint.textContent = t.imageBuiltIn
        ? '✓ Image: dùng schema built-in — sẵn sàng generate.'
        : '✓ Image: sẵn sàng generate.';
      hint.className = 'tpl-hint ready';
    } else if (t.video) {
      hint.textContent = '✓ Video: sẵn sàng generate.';
      hint.className = 'tpl-hint ready';
    } else {
      hint.textContent = '⚠ Video chưa có schema — generate 1 video trên Flow UI để extension học request mẫu.';
      hint.className = 'tpl-hint';
    }
  });
}

function renderResults(media: GenResultMedia[], note?: string): void {
  const section = document.getElementById('results');
  const grid = document.getElementById('results-grid');
  if (!section || !grid) return;
  section.classList.add('show');

  if (!media.length) {
    grid.innerHTML = `<div class="results-empty">${escHtml(note || 'Không có media trả về.')}</div>`;
    return;
  }

  grid.innerHTML = media
    .map((m) => {
      const src = m.url || m.dataUri || '';
      if (m.type === 'video') {
        return `<video controls src="${escHtml(src)}"></video>`;
      }
      return `<a href="${escHtml(src)}" target="_blank" rel="noopener"><img src="${escHtml(src)}" loading="lazy" /></a>`;
    })
    .join('');
}

function updateSettingsSummary(): void {
  const el = document.getElementById('settings-summary');
  if (!el) return;
  const modelEl = document.getElementById('gen-model') as HTMLSelectElement | null;
  const countEl = document.getElementById('gen-count') as HTMLInputElement | null;
  const attemptsEl = document.getElementById('gen-attempts') as HTMLInputElement | null;
  const model = modelEl?.selectedOptions[0]?.textContent || modelEl?.value || '—';
  const orient = genOrient.charAt(0).toUpperCase() + genOrient.slice(1);
  const count = countEl?.value || '1';
  const attempts = attemptsEl?.value || '3';
  const dot = ' <span class="muted">·</span> ';
  el.innerHTML =
    escHtml(model) + dot + orient + dot + `${escHtml(count)} ảnh` + dot + `${escHtml(attempts)} thử`;
}

function selectKind(kind: 'image' | 'video'): void {
  genKind = kind;
  document.querySelectorAll<HTMLElement>('.gen-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.getAttribute('data-kind') === kind);
  });
  refreshTemplateHint();
}

function initGeneratePanel(): void {
  document.querySelectorAll<HTMLElement>('.gen-tab').forEach((tab) => {
    tab.addEventListener('click', () => selectKind(tab.getAttribute('data-kind') as 'image' | 'video'));
  });

  document.querySelectorAll<HTMLElement>('.orient-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      genOrient = opt.getAttribute('data-orient') as 'landscape' | 'portrait' | 'square';
      document.querySelectorAll<HTMLElement>('.orient-opt').forEach((o) => {
        o.classList.toggle('active', o === opt);
      });
      updateSettingsSummary();
    });
  });

  // Collapsible settings card
  document.getElementById('settings-toggle')?.addEventListener('click', () => {
    document.getElementById('settings-card')?.classList.toggle('open');
  });
  document.getElementById('gen-model')?.addEventListener('change', updateSettingsSummary);
  document.getElementById('gen-count')?.addEventListener('input', updateSettingsSummary);
  document.getElementById('gen-attempts')?.addEventListener('input', updateSettingsSummary);

  const promptEl = document.getElementById('gen-prompt') as HTMLTextAreaElement | null;
  const modelEl = document.getElementById('gen-model') as HTMLSelectElement | null;
  const countEl = document.getElementById('gen-count') as HTMLInputElement | null;
  const attemptsEl = document.getElementById('gen-attempts') as HTMLInputElement | null;

  // Restore last form
  chrome.storage.local.get(FORM_KEY, (data) => {
    const f = data[FORM_KEY];
    if (!f) return;
    if (promptEl && f.prompt) promptEl.value = f.prompt;
    if (modelEl && f.model) modelEl.value = f.model;
    if (countEl && f.count) countEl.value = String(f.count);
    if (attemptsEl && f.maxAttempts) attemptsEl.value = String(f.maxAttempts);
    if (f.orientation) {
      genOrient = f.orientation;
      document.querySelectorAll<HTMLElement>('.orient-opt').forEach((o) =>
        o.classList.toggle('active', o.getAttribute('data-orient') === f.orientation),
      );
    }
    if (f.kind) selectKind(f.kind);
    updateSettingsSummary();
  });

  document.getElementById('btn-generate')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-generate') as HTMLButtonElement | null;
    if (!flowReady) {
      setGenStatus(flowBlockReason(), 'err');
      return;
    }
    const prompt = promptEl?.value.trim() || '';
    if (!prompt) {
      setGenStatus('Nhập prompt trước đã.', 'err');
      return;
    }
    const references = selectedRefs.map((r) => ({
      source: r.source,
      name: r.name,
      mime: r.mime,
      base64: r.base64,
      url: r.url,
      mediaId: r.mediaId,
    }));
    const params = {
      mediaType: genKind,
      prompt,
      model: modelEl?.value.trim() || undefined,
      orientation: genOrient,
      count: Math.max(1, Number(countEl?.value) || 1),
      maxAttempts: Math.max(1, Number(attemptsEl?.value) || 3),
      references,
    };
    // Persist form without bulky base64 refs.
    void chrome.storage.local.set({
      [FORM_KEY]: { ...params, kind: genKind, references: undefined },
    });

    activeRunId = `pending-${Date.now()}`;
    generating = true;
    if (btn) btn.disabled = true;
    setGenStatus('Bắt đầu…');

    chrome.runtime.sendMessage({ type: 'GENERATE', params }, (result?: GenResult) => {
      generating = false;
      if (btn) btn.disabled = !flowReady;
      if (chrome.runtime.lastError) {
        setGenStatus(chrome.runtime.lastError.message || 'Lỗi gửi message', 'err');
        return;
      }
      if (!result) {
        setGenStatus('Không nhận được kết quả.', 'err');
        return;
      }
      if (result.ok) {
        setGenStatus(`Xong sau ${result.attempts} lần thử.`, 'ok');
        renderResults(result.media, 'Request OK nhưng không có media (có thể bị safety-block).');
      } else {
        setGenStatus(`Thất bại sau ${result.attempts} lần: ${result.error || 'unknown'}`, 'err');
      }
    });
  });

  // Progress events carry the real runId; adopt it on first progress.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GEN_PROGRESS' && msg.progress?.runId && activeRunId?.startsWith('pending')) {
      activeRunId = msg.progress.runId;
      setGenStatus(msg.progress.message, msg.progress.phase === 'error' ? 'err' : '');
    }
  });

  initReferences();
  updateSettingsSummary();
  refreshTemplateHint();
}

document.getElementById('btn-media')?.addEventListener('click', () => openMediaModal());

document.getElementById('btn-batch')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('batch.html') });
});

document.getElementById('btn-flow')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' });
});

document.getElementById('btn-token')?.addEventListener('click', () => {
  const btn = document.getElementById('btn-token') as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = 'Opening...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => {
    if (chrome.runtime.lastError) return;
    btn.textContent = 'Refresh Token';
    btn.disabled = false;
  });
});

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchLog();
  initGeneratePanel();
});

/**
 * Multiple-prompt batch page — a wide table where each row is an independent
 * generation (own prompt + reference images), sharing one settings set. Rows run
 * in parallel up to a concurrency cap, reusing the background GENERATE pipeline.
 */
import { openMediaModal } from '../../utils/media-modal';

const MAX_REFS = 9;

type RowStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

interface BatchRef {
  source: 'upload' | 'project';
  name?: string;
  mime?: string;
  base64?: string;
  url?: string;
  mediaId?: string;
  thumb?: string;
}
interface ResultMedia { type: 'image' | 'video'; url: string }
interface Row {
  id: string;
  prompt: string;
  refs: BatchRef[];
  status: RowStatus;
  media: ResultMedia[];
  error?: string;
  msg?: string;
  attempts?: number;
}
interface Settings {
  mediaType: 'image' | 'video';
  model: string;
  videoModel: string; // video model family id (e.g. abra)
  videoLengthSeconds?: number; // video duration (only some families offer a choice)
  orientation: 'landscape' | 'portrait' | 'square';
  count: number;
  maxAttempts: number;
  concurrency: number;
}
interface VideoFamily { id: string; displayName: string; durations: number[] }
let videoFamilies: VideoFamily[] = [];
interface ProjectMedia { mediaId: string; type: 'image' | 'video'; prompt?: string; url?: string }

const STORE_KEY = 'batchState';
let rows: Row[] = [];
let globalRefs: BatchRef[] = []; // style refs auto-merged into every row at run time
let running = false;
let batchCancelled = false;
let seq = 0;

const settings: Settings = {
  mediaType: 'image', model: 'nano_banana_pro', videoModel: '', videoLengthSeconds: undefined,
  orientation: 'portrait', count: 1, maxAttempts: 3, concurrency: 3,
};

// ─── helpers ──────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
function uid(): string { return `r${Date.now().toString(36)}_${(seq++).toString(36)}`; }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function fileToBase64(file: File): Promise<{ base64: string; dataUri: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result);
      resolve({ dataUri, base64: dataUri.split(',')[1] || '' });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─── persistence (prompts + settings + result urls; not bulky base64 refs) ──
function saveBatch(): void {
  const slim = rows.map((r) => ({
    id: r.id, prompt: r.prompt, status: r.status, media: r.media, error: r.error, attempts: r.attempts,
    // keep project refs (small url/id) but drop uploaded base64 to avoid quota blowups
    refs: r.refs.filter((x) => x.source === 'project').map((x) => ({ source: x.source, url: x.url, mediaId: x.mediaId, thumb: x.thumb, name: x.name })),
  }));
  const slimGlobal = globalRefs
    .filter((x) => x.source === 'project')
    .map((x) => ({ source: x.source, url: x.url, mediaId: x.mediaId, thumb: x.thumb, name: x.name }));
  void chrome.storage.local.set({ [STORE_KEY]: { rows: slim, settings, globalRefs: slimGlobal, sel: { projectId: selProjectId, workflowId: selWorkflowId } } });
}
async function loadBatch(): Promise<void> {
  const data = await chrome.storage.local.get(STORE_KEY);
  const saved = data[STORE_KEY];
  if (!saved) return;
  if (saved.settings) Object.assign(settings, saved.settings);
  if (Array.isArray(saved.globalRefs)) globalRefs = saved.globalRefs as BatchRef[];
  if (saved.sel) { selProjectId = saved.sel.projectId || ''; selWorkflowId = saved.sel.workflowId || ''; }
  if (Array.isArray(saved.rows)) {
    rows = saved.rows.map((r: Partial<Row>) => ({
      id: r.id || uid(), prompt: r.prompt || '', refs: (r.refs as BatchRef[]) || [],
      status: r.status === 'running' || r.status === 'queued' ? 'idle' : (r.status as RowStatus) || 'idle',
      media: (r.media as ResultMedia[]) || [], error: r.error, attempts: r.attempts,
    }));
  }
}

// ─── settings ↔ inputs ──
function readSettings(): void {
  settings.mediaType = ($('s-kind') as HTMLSelectElement).value as Settings['mediaType'];
  settings.model = ($('s-model') as HTMLSelectElement).value;
  settings.videoModel = ($('s-vmodel') as HTMLSelectElement).value;
  const vlen = ($('s-vlen') as HTMLSelectElement).value;
  settings.videoLengthSeconds = vlen ? Number(vlen) : undefined;
  settings.orientation = ($('s-orient') as HTMLSelectElement).value as Settings['orientation'];
  settings.count = Math.max(1, Number(($('s-count') as HTMLInputElement).value) || 1);
  settings.maxAttempts = Math.max(1, Number(($('s-attempts') as HTMLInputElement).value) || 3);
  settings.concurrency = Math.min(5, Math.max(1, Number(($('s-concurrency') as HTMLInputElement).value) || 3));
  updateSettingsSummary();
  saveBatch();
}
function applySettingsToInputs(): void {
  ($('s-kind') as HTMLSelectElement).value = settings.mediaType;
  ($('s-model') as HTMLSelectElement).value = settings.model;
  ($('s-orient') as HTMLSelectElement).value = settings.orientation;
  ($('s-count') as HTMLInputElement).value = String(settings.count);
  ($('s-attempts') as HTMLInputElement).value = String(settings.maxAttempts);
  ($('s-concurrency') as HTMLInputElement).value = String(settings.concurrency);
  toggleModelFields();
}

// ─── video model + duration (sourced from videoModelFamilies) ──
function toggleModelFields(): void {
  const isVideo = settings.mediaType === 'video';
  ($('fld-image-model') as HTMLElement).style.display = isVideo ? 'none' : '';
  ($('fld-video-model') as HTMLElement).style.display = isVideo ? '' : 'none';
  const fam = videoFamilies.find((f) => f.id === settings.videoModel);
  const showLen = isVideo && !!fam && fam.durations.length > 1;
  ($('fld-video-len') as HTMLElement).style.display = showLen ? '' : 'none';
}

function fillVideoDurations(): void {
  const sel = $('s-vlen') as HTMLSelectElement;
  const fam = videoFamilies.find((f) => f.id === settings.videoModel);
  const durs = fam?.durations || [];
  sel.innerHTML = durs.map((d) => `<option value="${d}">${d}s</option>`).join('');
  // keep chosen duration if still valid, else default to the first
  if (settings.videoLengthSeconds && durs.includes(settings.videoLengthSeconds)) sel.value = String(settings.videoLengthSeconds);
  else settings.videoLengthSeconds = durs[0];
  if (settings.videoLengthSeconds != null) sel.value = String(settings.videoLengthSeconds);
  toggleModelFields();
}

function populateVideoModels(): void {
  chrome.runtime.sendMessage({ type: 'GET_VIDEO_MODELS', projectId: selProjectId || undefined }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    videoFamilies = (data.families as VideoFamily[]) || [];
    const sel = $('s-vmodel') as HTMLSelectElement;
    sel.innerHTML = videoFamilies.map((f) => `<option value="${escHtml(f.id)}">${escHtml(f.displayName)}</option>`).join('');
    if (!settings.videoModel || !videoFamilies.some((f) => f.id === settings.videoModel)) {
      settings.videoModel = videoFamilies[0]?.id || '';
    }
    sel.value = settings.videoModel;
    fillVideoDurations();
  });
}

// ─── rendering ──
const BADGE: Record<RowStatus, [string, string]> = {
  idle: ['b-idle', 'Chờ'], queued: ['b-queued', 'Trong hàng'], running: ['b-running', 'Đang chạy'],
  done: ['b-done', 'Hoàn thành'], failed: ['b-failed', 'Lỗi'],
};

function rowInnerHtml(row: Row, index: number): string {
  const refs = row.refs.length
    ? row.refs.map((r, i) => {
        const src = r.thumb || r.url || '';
        const img = src
          ? `<img src="${escHtml(src)}" loading="lazy" />`
          : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:7px;color:var(--muted);text-align:center">${escHtml((r.name || r.mediaId || '').slice(0, 16))}</span>`;
        return `<div class="ref-thumb">${img}<span class="rx" data-act="ref-del" data-i="${i}">&times;</span></div>`;
      }).join('')
    : '';
  const refsCell = `<div class="refs">${refs}<span class="ref-add" data-act="ref-edit" title="Thêm/sửa ảnh tham chiếu">+</span></div>`;

  const resultCell = row.media.length
    ? `<div class="result-grid">${row.media.slice(0, 4).map((m) =>
        m.type === 'video'
          ? `<a href="${escHtml(m.url)}" target="_blank" rel="noopener"><video src="${escHtml(m.url)}" muted></video></a>`
          : `<a href="${escHtml(m.url)}" target="_blank" rel="noopener"><img src="${escHtml(m.url)}" loading="lazy" /></a>`,
      ).join('')}</div>`
    : '<span class="result-empty">—</span>';

  const [bcls, btext] = BADGE[row.status];
  const msg = row.status === 'failed' && row.error
    ? `<div class="prog-msg err" title="${escHtml(row.error)}">${escHtml(truncate(row.error, 80))}</div>`
    : row.msg ? `<div class="prog-msg">${escHtml(truncate(row.msg, 60))}</div>` : '';
  const actions = `<div class="prog-actions">
      <span class="icon-btn" data-act="rerun" title="Chạy lại">↻</span>
      ${row.media.length ? `<span class="icon-btn" data-act="open" title="Mở kết quả">📁</span>` : ''}
      <span class="icon-btn" data-act="del" title="Xóa dòng">🗑</span>
    </div>`;

  return `
    <td class="c-chk"><input type="checkbox" data-act="sel" /></td>
    <td class="c-stt"><span class="stt">${index + 1}</span></td>
    <td class="c-run"><span class="icon-btn run" data-act="run" title="Chạy dòng này">▶</span></td>
    <td class="c-refs">${refsCell}</td>
    <td class="c-prompt"><textarea class="row-prompt" data-act="prompt" placeholder="Nhập prompt…">${escHtml(row.prompt)}</textarea></td>
    <td class="c-result">${resultCell}</td>
    <td class="c-prog"><span class="badge ${bcls}">${btext}</span>${msg}${actions}</td>`;
}

function render(): void {
  const tbody = $('rows')!;
  const empty = $('empty')!;
  empty.style.display = rows.length ? 'none' : 'block';
  tbody.innerHTML = rows.map((r, i) => `<tr data-row="${r.id}" class="${r.status === 'running' ? 'running' : ''}">${rowInnerHtml(r, i)}</tr>`).join('');
  $('count-pill')!.textContent = `${rows.length} dòng`;
}

function updateRow(row: Row): void {
  const tr = document.querySelector<HTMLTableRowElement>(`tr[data-row="${row.id}"]`);
  if (!tr) return render();
  const idx = rows.indexOf(row);
  tr.className = row.status === 'running' ? 'running' : '';
  tr.innerHTML = rowInnerHtml(row, idx);
}

// ─── generation ──
function runRow(row: Row, noReload: boolean): Promise<void> {
  return new Promise((resolve) => {
    row.status = 'running'; row.error = undefined; row.msg = 'Bắt đầu…'; row.media = [];
    updateRow(row);
    const params = {
      mediaType: settings.mediaType,
      prompt: row.prompt,
      model: settings.model || undefined,
      orientation: settings.orientation,
      count: settings.count,
      maxAttempts: settings.maxAttempts,
      references: mergeRefs(row).map((r) => ({ source: r.source, name: r.name, mime: r.mime, base64: r.base64, url: r.url, mediaId: r.mediaId })),
      projectId: selProjectId || undefined,
      workflowId: selWorkflowId || undefined,
      videoModelFamily: settings.mediaType === 'video' ? settings.videoModel || undefined : undefined,
      videoLengthSeconds: settings.mediaType === 'video' ? settings.videoLengthSeconds : undefined,
      clientId: row.id,
      noReload,
    };
    chrome.runtime.sendMessage({ type: 'GENERATE', params }, (result) => {
      if (chrome.runtime.lastError || !result) {
        row.status = 'failed'; row.error = chrome.runtime.lastError?.message || 'Không nhận được kết quả';
      } else if (result.ok) {
        row.status = 'done';
        row.attempts = result.attempts;
        row.media = (result.media || [])
          .map((m: { type: 'image' | 'video'; url?: string; dataUri?: string }) => ({ type: m.type, url: m.url || m.dataUri || '' }))
          .filter((m: ResultMedia) => m.url);
        row.msg = `Xong sau ${result.attempts} lần`;
        row.error = undefined;
      } else {
        row.status = 'failed'; row.error = result.error || 'unknown'; row.attempts = result.attempts;
      }
      saveBatch(); updateRow(row); resolve();
    });
  });
}

async function runMany(targets: Row[], noReload: boolean): Promise<void> {
  if (running || !targets.length) return;
  running = true;
  batchCancelled = false;
  setRunUI(true);
  targets.forEach((r) => { r.status = 'queued'; updateRow(r); });
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length && !batchCancelled) {
      const row = targets[i++]!;
      await runRow(row, noReload);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, targets.length) }, () => worker()));
  // Reset any rows still in queued state (cancelled before they started)
  rows.forEach((r) => { if (r.status === 'queued') { r.status = 'idle'; updateRow(r); } });
  running = false;
  batchCancelled = false;
  setRunUI(false);
}

function setRunUI(on: boolean): void {
  ($('btn-run-all') as HTMLButtonElement).disabled = on || !flowReady;
  ($('btn-run-all') as HTMLButtonElement).textContent = on ? '⏳ Đang chạy…' : '▶ Chạy tất cả';
  const stopBtn = $('btn-stop-all') as HTMLButtonElement | null;
  if (stopBtn) stopBtn.disabled = !on;
  reflectReady();
}

function clearBatch(): void {
  if (!confirm('Xóa toàn bộ dữ liệu batch (rows, refs, settings) về mặc định?')) return;
  rows = [];
  globalRefs = [];
  selProjectId = '';
  selWorkflowId = '';
  Object.assign(settings, {
    mediaType: 'image', model: 'nano_banana_pro', videoModel: '', videoLengthSeconds: undefined,
    orientation: 'portrait', count: 1, maxAttempts: 3, concurrency: 3,
  });
  void chrome.storage.local.remove(STORE_KEY);
  applySettingsToInputs();
  updateSettingsSummary();
  render();
  renderGlobalRefs();
  ($('pi-project') as HTMLSelectElement).value = '';
  ($('pi-workflow') as HTMLSelectElement).innerHTML = '<option value="">(mặc định)</option>';
  ($('pi-wf-manual') as HTMLInputElement).value = '';
}

// ─── flow readiness, token status, project info ──
let flowReady = false;

function blockReason(): string { return 'Cần mở tab Flow (đang đăng nhập, có token) trước khi tạo.'; }

function reflectReady(): void {
  if (!running) ($('btn-run-all') as HTMLButtonElement).disabled = !flowReady;
}

function fetchStatus(): void {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const el = $('token-status')!;
    if (!data.hasFlowTab) { el.textContent = 'chưa mở tab Flow'; el.className = 'bad'; }
    else if (data.flowKeyPresent) {
      const ageMin = Math.round((data.tokenAge || 0) / 60000);
      if ((data.tokenAge || 0) > 3_600_000) { el.textContent = `token cũ ${ageMin}m — mở Flow để refresh`; el.className = 'warn'; }
      else { el.textContent = `token synced ${ageMin}m`; el.className = 'ok'; }
    } else { el.textContent = 'no token'; el.className = 'bad'; }
    flowReady = !!(data.flowKeyPresent && data.hasFlowTab);
    reflectReady();
  });
}

// ─── project / workflow switching ──
let selProjectId = '';
let selWorkflowId = '';
let tabProjectId = '';

function populateProjects(): void {
  chrome.runtime.sendMessage({ type: 'GET_PROJECTS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const sel = $('pi-project') as HTMLSelectElement;
    const projects = (data.projects as { projectId: string; title: string }[]) || [];
    sel.innerHTML =
      '<option value="">(tab hiện tại)</option>' +
      projects.map((p) => `<option value="${escHtml(p.projectId)}">${escHtml(p.title)}</option>`).join('');
    sel.value = selProjectId || '';
    if (selProjectId) loadWorkflows(selProjectId);
  });
}

function loadWorkflows(pid: string): void {
  const sel = $('pi-workflow') as HTMLSelectElement;
  sel.innerHTML = '<option value="">(đang tải…)</option>';
  chrome.runtime.sendMessage({ type: 'GET_WORKFLOWS', projectId: pid }, (data) => {
    const wfs: { workflowId: string; count: number }[] =
      (!chrome.runtime.lastError && data && data.workflows) || [];
    sel.innerHTML =
      '<option value="">(mặc định)</option>' +
      wfs.map((w) => `<option value="${escHtml(w.workflowId)}">${escHtml(w.workflowId.slice(0, 8))}… (${w.count})</option>`).join('');
    sel.value = selWorkflowId || '';
  });
}

function fetchProjectInfo(): void {
  // Track the tab's project so '(tab hiện tại)' stays meaningful.
  chrome.runtime.sendMessage({ type: 'GET_PROJECT_INFO' }, (info) => {
    if (chrome.runtime.lastError || !info) return;
    tabProjectId = info.hasTab ? info.projectId || '' : '';
  });
}

function updateSettingsSummary(): void {
  const modelLabel = ($('s-model') as HTMLSelectElement).selectedOptions[0]?.textContent || settings.model;
  const kindLabel = settings.mediaType === 'image' ? 'Image' : 'Video';
  const orient = settings.orientation.charAt(0).toUpperCase() + settings.orientation.slice(1);
  $('settings-summary')!.innerHTML =
    `<span class="muted">Cài đặt chung:</span> ${escHtml(kindLabel)} · ${escHtml(modelLabel)} · ${orient} · ${settings.count} ảnh · ${settings.maxAttempts} thử · ${settings.concurrency} đồng thời`;
}

// Route per-row progress (matched by clientId) to its row.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'GEN_PROGRESS' && msg.progress?.clientId) {
    const row = rows.find((r) => r.id === msg.progress.clientId);
    if (row && row.status === 'running') { row.msg = msg.progress.message; updateRow(row); }
  }
  if (msg?.type === 'STATUS_PUSH') { fetchStatus(); fetchProjectInfo(); }
});

// ─── reference picker modal (target = a row, or the global style set) ──
type RefTarget = Row | 'global';
let refTarget: RefTarget | null = null;

function targetRefs(): BatchRef[] | null {
  if (refTarget === 'global') return globalRefs;
  return refTarget ? refTarget.refs : null;
}

function openRefModal(target: RefTarget): void {
  refTarget = target;
  $('ref-modal-title')!.textContent = target === 'global'
    ? 'Ảnh style chung (áp cho mọi dòng)'
    : `Ảnh tham chiếu — dòng ${rows.indexOf(target) + 1}`;
  $('ref-pg')!.innerHTML = '';
  renderModalRefs();
  $('ref-modal')!.classList.add('open');
}
function closeRefModal(): void { $('ref-modal')!.classList.remove('open'); refTarget = null; }

function renderModalRefs(): void {
  const refs = targetRefs();
  if (!refs) return;
  $('ref-modal-hint')!.textContent = `${refs.length}/${MAX_REFS} ảnh.`;
  $('ref-current')!.innerHTML = refs.map((r, i) => {
    const src = r.thumb || r.url || '';
    const img = src ? `<img src="${escHtml(src)}" />` : `<span style="font-size:7px;color:var(--muted)">${escHtml((r.name || r.mediaId || '').slice(0, 12))}</span>`;
    return `<div class="ref-thumb">${img}<span class="rx" data-mact="del" data-i="${i}">&times;</span></div>`;
  }).join('');
  document.querySelectorAll<HTMLElement>('#ref-pg .pm').forEach((el) => {
    const id = el.getAttribute('data-media-id');
    el.classList.toggle('sel', refs.some((r) => r.source === 'project' && r.mediaId === id));
  });
  // reflect into the target's view
  if (refTarget === 'global') renderGlobalRefs();
  else if (refTarget) updateRow(refTarget);
}

function renderGlobalRefs(): void {
  const strip = $('global-refs')!;
  strip.innerHTML = globalRefs.map((r, i) => {
    const src = r.thumb || r.url || '';
    const img = src
      ? `<img src="${escHtml(src)}" loading="lazy" />`
      : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:7px;color:var(--muted);text-align:center">${escHtml((r.name || r.mediaId || '').slice(0, 14))}</span>`;
    return `<div class="ref-thumb">${img}<span class="rx" data-gdel="${i}">&times;</span></div>`;
  }).join('') + '<span class="ref-add" id="global-add" title="Thêm ảnh style chung">+</span>';
  $('global-hint')!.textContent = globalRefs.length
    ? `${globalRefs.length} ảnh · tự ghép vào mọi dòng khi chạy`
    : 'Chưa có — bấm + để thêm';
  $('global-add')!.addEventListener('click', () => openRefModal('global'));
  strip.querySelectorAll<HTMLElement>('[data-gdel]').forEach((x) =>
    x.addEventListener('click', () => {
      globalRefs.splice(Number(x.getAttribute('data-gdel')), 1);
      saveBatch(); renderGlobalRefs();
      if (refTarget === 'global') renderModalRefs();
    }),
  );
}

/** global style refs first, then the row's own refs; dedup, cap at MAX_REFS. */
function mergeRefs(row: Row): BatchRef[] {
  const out: BatchRef[] = [];
  const seen = new Set<string>();
  const key = (r: BatchRef) => `${r.source}:${r.mediaId || r.url || r.name || (r.base64 || '').slice(0, 24)}`;
  for (const r of [...globalRefs, ...row.refs]) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

function loadProjectGrid(): void {
  const pg = $('ref-pg')!;
  pg.innerHTML = '<div class="modal-hint">Đang tải từ project…</div>';
  chrome.runtime.sendMessage({ type: 'GET_PROJECT_MEDIA', projectId: selProjectId || undefined }, (data) => {
    if (chrome.runtime.lastError || !data) { pg.innerHTML = `<div class="modal-hint">Lỗi: ${escHtml(chrome.runtime.lastError?.message || 'no data')}</div>`; return; }
    if (data.error) { pg.innerHTML = `<div class="modal-hint">${escHtml(data.error)}</div>`; return; }
    const all = (data.media as ProjectMedia[]) || [];
    if (!all.length) { pg.innerHTML = '<div class="modal-hint">Project chưa có media.</div>'; return; }
    pg.innerHTML = all.map((m) => {
      const img = m.url ? `<img src="${escHtml(m.url)}" loading="lazy" />` : `<span style="font-size:7px;color:var(--muted)">${escHtml((m.prompt || m.mediaId).slice(0, 16))}</span>`;
      return `<div class="pm" data-media-id="${escHtml(m.mediaId)}">${img}</div>`;
    }).join('');
    pg.querySelectorAll<HTMLElement>('.pm').forEach((el) => {
      const id = el.getAttribute('data-media-id');
      const m = all.find((x) => x.mediaId === id);
      if (m) el.addEventListener('click', () => toggleProjectRef(m));
    });
    renderModalRefs();
  });
}

function toggleProjectRef(m: ProjectMedia): void {
  const refs = targetRefs();
  if (!refs) return;
  const idx = refs.findIndex((r) => r.source === 'project' && r.mediaId === m.mediaId);
  if (idx >= 0) refs.splice(idx, 1);
  else if (refs.length >= MAX_REFS) { $('ref-modal-hint')!.textContent = `Tối đa ${MAX_REFS} ảnh.`; return; }
  else refs.push({ source: 'project', url: m.url, mediaId: m.mediaId, thumb: m.url, name: m.prompt || m.mediaId });
  saveBatch(); renderModalRefs();
}

async function addUploadsToActive(files: FileList): Promise<void> {
  const refs = targetRefs();
  if (!refs) return;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    if (refs.length >= MAX_REFS) { $('ref-modal-hint')!.textContent = `Tối đa ${MAX_REFS} ảnh.`; break; }
    const { base64, dataUri } = await fileToBase64(file);
    refs.push({ source: 'upload', name: file.name, mime: file.type, base64, thumb: dataUri });
  }
  saveBatch(); renderModalRefs();
}

// ─── row mutations ──
function addRowsFromPaste(): void {
  const ta = $('paste') as HTMLTextAreaElement;
  const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  for (const line of lines) rows.push({ id: uid(), prompt: line, refs: [], status: 'idle', media: [] });
  ta.value = '';
  saveBatch(); render();
}
function addEmptyRow(): void {
  rows.push({ id: uid(), prompt: '', refs: [], status: 'idle', media: [] });
  saveBatch(); render();
}
function deleteSelected(): void {
  const keep: Row[] = [];
  document.querySelectorAll<HTMLTableRowElement>('#rows tr[data-row]').forEach((tr) => {
    const chk = tr.querySelector<HTMLInputElement>('input[data-act="sel"]');
    const row = rows.find((r) => r.id === tr.getAttribute('data-row'));
    if (row && !chk?.checked) keep.push(row);
  });
  rows = keep;
  ($('chk-all') as HTMLInputElement).checked = false;
  saveBatch(); render();
}

// ─── event wiring ──
function initToolbar(): void {
  $('btn-add-paste')!.addEventListener('click', addRowsFromPaste);
  $('btn-add-row')!.addEventListener('click', addEmptyRow);
  $('btn-del-selected')!.addEventListener('click', deleteSelected);
  $('btn-run-all')!.addEventListener('click', () => {
    if (!flowReady) { fetchStatus(); return; }
    readSettings();
    const targets = rows.filter((r) => r.status !== 'done' && r.prompt.trim());
    void runMany(targets, true);
  });
  $('btn-stop-all')!.addEventListener('click', () => {
    if (!running) return;
    batchCancelled = true;
    rows.forEach((r) => { if (r.status === 'queued') { r.status = 'idle'; updateRow(r); } });
  });
  $('btn-clear-batch')!.addEventListener('click', clearBatch);
  ['s-model', 's-orient', 's-count', 's-attempts', 's-concurrency', 's-vlen'].forEach((id) =>
    $(id)!.addEventListener('change', readSettings),
  );
  $('s-kind')!.addEventListener('change', () => {
    readSettings();
    if (settings.mediaType === 'video' && !videoFamilies.length) populateVideoModels();
    else toggleModelFields();
  });
  $('s-vmodel')!.addEventListener('change', () => {
    settings.videoModel = ($('s-vmodel') as HTMLSelectElement).value;
    fillVideoDurations();
    readSettings();
  });
  $('settings-toggle')!.addEventListener('click', () => $('settings-card')!.classList.toggle('open'));

  // Project-bar actions (footer just shows token status + credit now)
  $('pi-open')!.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' }));
  $('pi-media')!.addEventListener('click', () => openMediaModal(selProjectId || undefined));
  $('pi-refresh')!.addEventListener('click', () => { populateProjects(); populateVideoModels(); fetchProjectInfo(); fetchStatus(); });
  $('pi-project')!.addEventListener('change', (e) => {
    selProjectId = (e.target as HTMLSelectElement).value;
    selWorkflowId = '';
    ($('pi-wf-manual') as HTMLInputElement).value = '';
    if (selProjectId) loadWorkflows(selProjectId);
    else ($('pi-workflow') as HTMLSelectElement).innerHTML = '<option value="">(mặc định)</option>';
    populateVideoModels();
    saveBatch();
  });
  $('pi-workflow')!.addEventListener('change', (e) => {
    selWorkflowId = (e.target as HTMLSelectElement).value;
    ($('pi-wf-manual') as HTMLInputElement).value = '';
    saveBatch();
  });
  $('pi-wf-manual')!.addEventListener('input', (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    selWorkflowId = v.match(/\/edit\/([0-9a-f-]{36})/)?.[1] || v;
    if (v) ($('pi-workflow') as HTMLSelectElement).value = '';
    saveBatch();
  });
  $('pi-rename')!.addEventListener('click', () => {
    const pid = selProjectId || tabProjectId;
    if (!pid) { alert('Chọn một project (hoặc mở tab Flow) trước khi đổi tên.'); return; }
    const projSel = $('pi-project') as HTMLSelectElement;
    const cur = selProjectId ? (projSel.selectedOptions[0]?.textContent || '').trim() : '';
    const name = window.prompt('Tên project mới:', cur);
    if (name == null) return;
    const title = name.trim();
    if (!title) return;
    const btn = $('pi-rename') as HTMLButtonElement;
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'UPDATE_PROJECT_TITLE', projectId: pid, title }, (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res?.ok) {
        alert('Đổi tên lỗi: ' + (res?.error || chrome.runtime.lastError?.message || 'unknown'));
        return;
      }
      populateProjects(); // refresh dropdown to show the new title
    });
  });
  $('chk-all')!.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    document.querySelectorAll<HTMLInputElement>('#rows input[data-act="sel"]').forEach((c) => (c.checked = on));
  });
}

function initTableDelegation(): void {
  const tbody = $('rows')!;
  tbody.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el) return;
    const tr = el.closest('tr[data-row]') as HTMLTableRowElement | null;
    const row = tr && rows.find((r) => r.id === tr.getAttribute('data-row'));
    if (!row) return;
    const act = el.getAttribute('data-act');
    if (act === 'run' || act === 'rerun') {
      if (!flowReady) { row.msg = blockReason(); updateRow(row); fetchStatus(); return; }
      readSettings();
      void runMany([row], running);
    }
    else if (act === 'open') { const m = row.media[0]; if (m?.url) window.open(m.url, '_blank'); }
    else if (act === 'del') { rows = rows.filter((r) => r !== row); saveBatch(); render(); }
    else if (act === 'ref-edit') openRefModal(row);
    else if (act === 'ref-del') { const i = Number(el.getAttribute('data-i')); row.refs.splice(i, 1); saveBatch(); updateRow(row); }
  });
  tbody.addEventListener('input', (e) => {
    const ta = e.target as HTMLElement;
    if (ta.getAttribute('data-act') !== 'prompt') return;
    const tr = ta.closest('tr[data-row]') as HTMLTableRowElement | null;
    const row = tr && rows.find((r) => r.id === tr.getAttribute('data-row'));
    if (row) { row.prompt = (ta as HTMLTextAreaElement).value; saveBatch(); }
  });
}

function initRefModal(): void {
  $('ref-modal-close')!.addEventListener('click', closeRefModal);
  $('ref-modal')!.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRefModal(); });
  $('ref-upload')!.addEventListener('click', () => ($('ref-file') as HTMLInputElement).click());
  $('ref-file')!.addEventListener('change', (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files) void addUploadsToActive(files);
    (e.target as HTMLInputElement).value = '';
  });
  $('ref-load-project')!.addEventListener('click', loadProjectGrid);
  $('ref-current')!.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).closest('[data-mact="del"]') as HTMLElement | null;
    const refs = targetRefs();
    if (!x || !refs) return;
    refs.splice(Number(x.getAttribute('data-i')), 1);
    saveBatch(); renderModalRefs();
  });
}

async function main(): Promise<void> {
  await loadBatch();
  applySettingsToInputs();
  updateSettingsSummary();
  initToolbar();
  initTableDelegation();
  initRefModal();
  render();
  renderGlobalRefs();
  fetchStatus();
  fetchProjectInfo();
  populateProjects();
  populateVideoModels();
  setInterval(() => { fetchStatus(); fetchProjectInfo(); }, 15000);
}
void main();

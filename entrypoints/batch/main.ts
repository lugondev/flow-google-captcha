/**
 * Multiple-prompt batch page — a wide table where each row is an independent
 * generation (own prompt + reference images), sharing one settings set. Rows run
 * in parallel up to a concurrency cap, reusing the background GENERATE pipeline.
 */
export {};

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
  orientation: 'landscape' | 'portrait' | 'square';
  count: number;
  maxAttempts: number;
  concurrency: number;
}
interface ProjectMedia { mediaId: string; type: 'image' | 'video'; prompt?: string; url?: string }

const STORE_KEY = 'batchState';
let rows: Row[] = [];
let running = false;
let seq = 0;

const settings: Settings = {
  mediaType: 'image', model: 'nano_banana_pro', orientation: 'portrait',
  count: 1, maxAttempts: 3, concurrency: 3,
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
  void chrome.storage.local.set({ [STORE_KEY]: { rows: slim, settings } });
}
async function loadBatch(): Promise<void> {
  const data = await chrome.storage.local.get(STORE_KEY);
  const saved = data[STORE_KEY];
  if (!saved) return;
  if (saved.settings) Object.assign(settings, saved.settings);
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
  settings.orientation = ($('s-orient') as HTMLSelectElement).value as Settings['orientation'];
  settings.count = Math.max(1, Number(($('s-count') as HTMLInputElement).value) || 1);
  settings.maxAttempts = Math.max(1, Number(($('s-attempts') as HTMLInputElement).value) || 3);
  settings.concurrency = Math.min(5, Math.max(1, Number(($('s-concurrency') as HTMLInputElement).value) || 3));
  saveBatch();
}
function applySettingsToInputs(): void {
  ($('s-kind') as HTMLSelectElement).value = settings.mediaType;
  ($('s-model') as HTMLSelectElement).value = settings.model;
  ($('s-orient') as HTMLSelectElement).value = settings.orientation;
  ($('s-count') as HTMLInputElement).value = String(settings.count);
  ($('s-attempts') as HTMLInputElement).value = String(settings.maxAttempts);
  ($('s-concurrency') as HTMLInputElement).value = String(settings.concurrency);
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
      references: row.refs.map((r) => ({ source: r.source, name: r.name, mime: r.mime, base64: r.base64, url: r.url, mediaId: r.mediaId })),
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
  running = true; setRunUI(true);
  targets.forEach((r) => { r.status = 'queued'; updateRow(r); });
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const row = targets[i++]!;
      await runRow(row, noReload);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, targets.length) }, () => worker()));
  running = false; setRunUI(false);
}

function setRunUI(on: boolean): void {
  ($('btn-run-all') as HTMLButtonElement).disabled = on;
  ($('btn-run-all') as HTMLButtonElement).textContent = on ? '⏳ Đang chạy…' : '▶ Chạy tất cả';
}

// Route per-row progress (matched by clientId) to its row.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'GEN_PROGRESS' && msg.progress?.clientId) {
    const row = rows.find((r) => r.id === msg.progress.clientId);
    if (row && row.status === 'running') { row.msg = msg.progress.message; updateRow(row); }
  }
});

// ─── reference picker modal ──
let activeRefRow: Row | null = null;

function openRefModal(row: Row): void {
  activeRefRow = row;
  $('ref-modal-title')!.textContent = `Ảnh tham chiếu — dòng ${rows.indexOf(row) + 1}`;
  $('ref-modal-hint')!.textContent = `${row.refs.length}/${MAX_REFS} ảnh.`;
  $('ref-pg')!.innerHTML = '';
  renderModalRefs();
  $('ref-modal')!.classList.add('open');
}
function closeRefModal(): void { $('ref-modal')!.classList.remove('open'); activeRefRow = null; }

function renderModalRefs(): void {
  if (!activeRefRow) return;
  const row = activeRefRow;
  $('ref-modal-hint')!.textContent = `${row.refs.length}/${MAX_REFS} ảnh.`;
  $('ref-current')!.innerHTML = row.refs.map((r, i) => {
    const src = r.thumb || r.url || '';
    const img = src ? `<img src="${escHtml(src)}" />` : `<span style="font-size:7px;color:var(--muted)">${escHtml((r.name || r.mediaId || '').slice(0, 12))}</span>`;
    return `<div class="ref-thumb">${img}<span class="rx" data-mact="del" data-i="${i}">&times;</span></div>`;
  }).join('');
  // sync project grid selection
  document.querySelectorAll<HTMLElement>('#ref-pg .pm').forEach((el) => {
    const id = el.getAttribute('data-media-id');
    el.classList.toggle('sel', row.refs.some((r) => r.source === 'project' && r.mediaId === id));
  });
  updateRow(row);
}

function loadProjectGrid(): void {
  const pg = $('ref-pg')!;
  pg.innerHTML = '<div class="modal-hint">Đang tải từ project…</div>';
  chrome.runtime.sendMessage({ type: 'GET_PROJECT_MEDIA' }, (data) => {
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
  if (!activeRefRow) return;
  const row = activeRefRow;
  const idx = row.refs.findIndex((r) => r.source === 'project' && r.mediaId === m.mediaId);
  if (idx >= 0) row.refs.splice(idx, 1);
  else if (row.refs.length >= MAX_REFS) { $('ref-modal-hint')!.textContent = `Tối đa ${MAX_REFS} ảnh.`; return; }
  else row.refs.push({ source: 'project', url: m.url, mediaId: m.mediaId, thumb: m.url, name: m.prompt || m.mediaId });
  saveBatch(); renderModalRefs();
}

async function addUploadsToActive(files: FileList): Promise<void> {
  if (!activeRefRow) return;
  const row = activeRefRow;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    if (row.refs.length >= MAX_REFS) { $('ref-modal-hint')!.textContent = `Tối đa ${MAX_REFS} ảnh.`; break; }
    const { base64, dataUri } = await fileToBase64(file);
    row.refs.push({ source: 'upload', name: file.name, mime: file.type, base64, thumb: dataUri });
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
    readSettings();
    const targets = rows.filter((r) => r.status !== 'done' && r.prompt.trim());
    void runMany(targets, true); // parallel batch → suppress per-row tab reload
  });
  ['s-kind', 's-model', 's-orient', 's-count', 's-attempts', 's-concurrency'].forEach((id) =>
    $(id)!.addEventListener('change', readSettings),
  );
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
    if (act === 'run') { readSettings(); void runMany([row], !running ? false : true); }
    else if (act === 'rerun') { readSettings(); void runMany([row], !running ? false : true); }
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
    if (!x || !activeRefRow) return;
    activeRefRow.refs.splice(Number(x.getAttribute('data-i')), 1);
    saveBatch(); renderModalRefs();
  });
}

async function main(): Promise<void> {
  await loadBatch();
  applySettingsToInputs();
  initToolbar();
  initTableDelegation();
  initRefModal();
  render();
}
void main();

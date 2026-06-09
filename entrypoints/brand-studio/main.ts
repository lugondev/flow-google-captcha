/**
 * Brand Studio — combine product images with branding assets to generate
 * branded product photos via the Flow generation pipeline.
 */

type Status = 'idle' | 'running' | 'done' | 'failed';

interface Asset {
  id: string;
  source: 'upload' | 'project';
  name?: string;
  mediaId?: string;
  base64?: string;
  mime?: string;
  thumb?: string;
}

interface Product {
  id: string;
  source: 'upload' | 'project';
  name: string;
  mediaId?: string;
  base64?: string;
  mime?: string;
  thumb: string;
  status: Status;
  progress?: string;
  outputs: Array<{ url: string }>;
  error?: string;
}

interface Config {
  brandName: string;
  brandDesc: string;
  promptTemplate: string;
  model: string;
  orientation: 'landscape' | 'portrait' | 'square';
  count: number;
  maxAttempts: number;
}

interface GenResult {
  ok: boolean;
  media: Array<{ url?: string; dataUri?: string }>;
  error?: string;
  attempts?: number;
}

interface ProjectMedia { mediaId: string; type: 'image' | 'video'; url?: string; prompt?: string }

const STORE_KEY = 'brandStudioState';
const MAX_BRAND_ASSETS = 8;
const CONCURRENCY = 3;

let products: Product[] = [];
let brandAssets: Asset[] = [];
let selProjectId = '';
let selWorkflowId = '';
let running = false;
let cancelled = false;
let seq = 0;

const config: Config = {
  brandName: '',
  brandDesc: '',
  promptTemplate: 'Professional product photography featuring {brand_name} branding, {brand_desc}, clean studio lighting, high detail',
  model: 'nano_banana_pro',
  orientation: 'portrait',
  count: 2,
  maxAttempts: 3,
};

// ─── helpers ──────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
function uid(): string { return `p${Date.now().toString(36)}_${(seq++).toString(36)}`; }
function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
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

// ─── persistence ──────────────────────────────────────────────
function save(): void {
  const slimProducts = products.map((p) => ({
    id: p.id, source: p.source, name: p.name, mime: p.mime,
    mediaId: p.mediaId,
    thumb: p.source === 'project' ? p.thumb : undefined,
    status: p.status === 'running' ? 'idle' : p.status,
    outputs: p.outputs, error: p.error,
  }));
  const slimAssets = brandAssets.map((a) => ({
    id: a.id, source: a.source, name: a.name, mime: a.mime,
    mediaId: a.mediaId,
    thumb: a.source === 'project' ? a.thumb : undefined,
  }));
  void chrome.storage.local.set({
    [STORE_KEY]: {
      products: slimProducts, brandAssets: slimAssets, config,
      sel: { projectId: selProjectId, workflowId: selWorkflowId },
    },
  });
}

async function loadState(): Promise<void> {
  const data = await chrome.storage.local.get(STORE_KEY);
  const saved = data[STORE_KEY];
  if (!saved) return;
  if (saved.config) Object.assign(config, saved.config);
  if (saved.sel) {
    selProjectId = saved.sel.projectId || '';
    selWorkflowId = saved.sel.workflowId || '';
  }
  if (Array.isArray(saved.products)) {
    products = (saved.products as Partial<Product>[]).map((p) => ({
      id: p.id || uid(), source: p.source || 'upload', name: p.name || '',
      mediaId: p.mediaId, mime: p.mime, thumb: p.thumb || '',
      status: (p.status === 'running' ? 'idle' : p.status || 'idle') as Status,
      outputs: p.outputs || [], error: p.error,
    }));
  }
  if (Array.isArray(saved.brandAssets)) {
    brandAssets = (saved.brandAssets as Asset[]).map((a) => ({ ...a }));
  }
}

// ─── product management ───────────────────────────────────────
async function addProductFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    const { base64, dataUri } = await fileToBase64(file);
    products.push({
      id: uid(), source: 'upload', name: file.name, base64, mime: file.type,
      thumb: dataUri, status: 'idle', outputs: [],
    });
  }
  save(); render();
}

function addProductFromProject(m: ProjectMedia): void {
  if (products.some((p) => p.mediaId === m.mediaId)) return;
  products.push({
    id: uid(), source: 'project', name: (m.prompt || m.mediaId).slice(0, 40),
    mediaId: m.mediaId, thumb: m.url || '', status: 'idle', outputs: [],
  });
  save(); render();
}

// ─── brand asset management ──────────────────────────────────
async function addBrandAssetFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    if (brandAssets.length >= MAX_BRAND_ASSETS) break;
    const { base64, dataUri } = await fileToBase64(file);
    brandAssets.push({
      id: uid(), source: 'upload', name: file.name, base64, mime: file.type, thumb: dataUri,
    });
  }
  save(); renderBrandAssets();
}

function addBrandAssetFromProject(m: ProjectMedia): void {
  if (brandAssets.some((a) => a.mediaId === m.mediaId)) return;
  if (brandAssets.length >= MAX_BRAND_ASSETS) return;
  brandAssets.push({ id: uid(), source: 'project', mediaId: m.mediaId, thumb: m.url || '', name: m.prompt });
  save(); renderBrandAssets();
}

function removeBrandAsset(id: string): void {
  brandAssets = brandAssets.filter((a) => a.id !== id);
  save(); renderBrandAssets();
}

// ─── rendering ───────────────────────────────────────────────
function renderBrandAssets(): void {
  const grid = $('bs-assets-grid')!;
  grid.innerHTML = brandAssets.map((a) =>
    `<div class="asset-item">
      ${a.thumb ? `<img class="asset-thumb" src="${escHtml(a.thumb)}" title="${escHtml(a.name || a.mediaId || '')}" />`
                : `<div class="asset-noimg">${escHtml((a.name || a.mediaId || '').slice(0, 10))}</div>`}
      <button class="asset-rm" data-rmid="${escHtml(a.id)}">×</button>
    </div>`,
  ).join('');
  grid.querySelectorAll<HTMLElement>('[data-rmid]').forEach((btn) => {
    btn.addEventListener('click', () => removeBrandAsset(btn.getAttribute('data-rmid')!));
  });
  $('bs-assets-hint')!.textContent = `${brandAssets.length}/${MAX_BRAND_ASSETS}`;
}

function statusHtml(p: Product): string {
  if (p.status === 'idle') return '<span class="badge b-idle">idle</span>';
  if (p.status === 'running') {
    return `<span class="badge b-running anim">⟳</span>${p.progress ? `<span class="prog-msg">${escHtml(p.progress)}</span>` : ''}`;
  }
  if (p.status === 'done') return `<span class="badge b-done">✓ ${p.outputs.length} ảnh</span>`;
  return `<span class="badge b-failed">✗</span><span class="prog-msg err">${escHtml(p.error || 'Thất bại')}</span>`;
}

function outputsHtml(p: Product): string {
  if (p.outputs.length) {
    return p.outputs.map((o) =>
      `<a href="${escHtml(o.url)}" download target="_blank" title="Tải xuống"><img class="output-img" src="${escHtml(o.url)}" /></a>`,
    ).join('');
  }
  if (p.status === 'running') return '<div class="output-ph anim">…</div>';
  return '<div class="output-ph" style="color:var(--muted)">—</div>';
}

function renderProductEl(el: HTMLElement, p: Product): void {
  const classes = ['product-row'];
  if (p.status === 'running') classes.push('running');
  else if (p.status === 'done') classes.push('done');
  else if (p.status === 'failed') classes.push('failed');
  el.className = classes.join(' ');
  const statusEl = el.querySelector('.prod-status');
  const outputEl = el.querySelector('.prod-outputs');
  if (statusEl) statusEl.innerHTML = statusHtml(p);
  if (outputEl) outputEl.innerHTML = outputsHtml(p);
}

function render(): void {
  const list = $('bs-products-list')!;
  const empty = $('bs-empty')!;
  empty.style.display = products.length ? 'none' : '';

  const existingIds = new Set(
    Array.from(list.querySelectorAll<HTMLElement>('[data-prod-id]')).map((el) => el.getAttribute('data-prod-id')),
  );
  for (const id of existingIds) {
    if (!products.some((p) => p.id === id)) list.querySelector(`[data-prod-id="${id}"]`)?.remove();
  }

  products.forEach((p, i) => {
    let el = list.querySelector<HTMLElement>(`[data-prod-id="${p.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-prod-id', p.id);
      const thumbHtml = p.thumb
        ? `<img class="prod-thumb" src="${escHtml(p.thumb)}" />`
        : `<div class="prod-noimg">${escHtml(p.name.slice(0, 12))}</div>`;
      el.innerHTML = `
        ${thumbHtml}
        <div class="prod-body">
          <div class="prod-name">${escHtml(p.name)}</div>
          <div class="prod-status"></div>
        </div>
        <div class="prod-arrow">→</div>
        <div class="prod-outputs"></div>
        <button class="prod-rm" title="Xóa" data-rmid="${escHtml(p.id)}">×</button>`;
      el.querySelector('.prod-rm')!.addEventListener('click', () => {
        if (p.status === 'running') return;
        products = products.filter((x) => x.id !== p.id);
        save(); render();
      });
      const next = list.children[i];
      if (next) list.insertBefore(el, next); else list.appendChild(el);
    }
    renderProductEl(el, p);
  });

  updateFooter();
}

function updateFooter(): void {
  const btn = $<HTMLButtonElement>('bs-generate')!;
  const stop = $<HTMLButtonElement>('bs-stop')!;
  const info = $('bs-footer-info')!;
  btn.disabled = running || !products.length;
  stop.disabled = !running;
  const done = products.filter((p) => p.status === 'done').length;
  const total = products.length;
  info.textContent = total
    ? `${total} sản phẩm · ${done} hoàn thành · ${total - done} còn lại`
    : 'Chưa có sản phẩm';
}

// ─── picker modal ─────────────────────────────────────────────
type PickerTarget = 'product' | 'brand';
let pickerTarget: PickerTarget = 'product';

function openPicker(target: PickerTarget): void {
  pickerTarget = target;
  $('bs-picker-title')!.textContent = target === 'product'
    ? 'Chọn ảnh sản phẩm từ project'
    : 'Chọn ảnh brand assets từ project';
  $('bs-picker-hint')!.textContent = target === 'product'
    ? 'Có thể chọn nhiều ảnh.'
    : `Chọn logo, style refs… (${brandAssets.length}/${MAX_BRAND_ASSETS})`;
  $('bs-picker-modal')!.classList.add('open');
  loadPickerGrid();
}

function closePicker(): void {
  $('bs-picker-modal')!.classList.remove('open');
}

function loadPickerGrid(): void {
  const pg = $('bs-picker-pg')!;
  pg.innerHTML = '<div class="modal-hint">Đang tải từ project…</div>';
  chrome.runtime.sendMessage({ type: 'GET_PROJECT_MEDIA', projectId: selProjectId || undefined }, (data) => {
    if (chrome.runtime.lastError || !data || data.error) {
      pg.innerHTML = `<div class="modal-hint">Lỗi: ${escHtml(chrome.runtime.lastError?.message || data?.error || 'no data')}</div>`;
      return;
    }
    const all = ((data.media as ProjectMedia[]) || []).filter((m) => m.type === 'image');
    if (!all.length) { pg.innerHTML = '<div class="modal-hint">Project chưa có ảnh.</div>'; return; }
    pg.innerHTML = all.map((m) => {
      const img = m.url
        ? `<img src="${escHtml(m.url)}" loading="lazy" />`
        : `<span style="font-size:7px;color:var(--muted);padding:4px;display:block;text-align:center">${escHtml((m.prompt || m.mediaId).slice(0, 16))}</span>`;
      return `<div class="pm" data-media-id="${escHtml(m.mediaId)}" data-url="${escHtml(m.url || '')}" data-prompt="${escHtml(m.prompt || '')}">${img}</div>`;
    }).join('');
    refreshPickerSelection();
    pg.querySelectorAll<HTMLElement>('.pm').forEach((el) => {
      el.addEventListener('click', () => {
        const m: ProjectMedia = {
          mediaId: el.getAttribute('data-media-id')!,
          type: 'image',
          url: el.getAttribute('data-url') || undefined,
          prompt: el.getAttribute('data-prompt') || undefined,
        };
        if (pickerTarget === 'product') addProductFromProject(m);
        else addBrandAssetFromProject(m);
        refreshPickerSelection();
      });
    });
  });
}

function refreshPickerSelection(): void {
  $('bs-picker-pg')!.querySelectorAll<HTMLElement>('.pm').forEach((el) => {
    const id = el.getAttribute('data-media-id')!;
    const selected = pickerTarget === 'product'
      ? products.some((p) => p.mediaId === id)
      : brandAssets.some((a) => a.mediaId === id);
    el.classList.toggle('sel', selected);
  });
  if (pickerTarget === 'brand') {
    $('bs-picker-hint')!.textContent = `Chọn logo, style refs… (${brandAssets.length}/${MAX_BRAND_ASSETS})`;
  }
}

// ─── upload helper ───────────────────────────────────────────
async function uploadAsset(a: Asset): Promise<string | null> {
  if (a.mediaId) return a.mediaId;
  if (!a.base64) return null;
  const result: { mediaId?: string } = await new Promise((resolve) =>
    chrome.runtime.sendMessage({
      type: 'UPLOAD_IMAGE',
      ref: { source: 'upload', base64: a.base64, mime: a.mime || 'image/jpeg', name: a.name || 'image.jpg' },
      projectId: selProjectId || undefined,
      workflowId: selWorkflowId || undefined,
    }, resolve),
  );
  return result?.mediaId || null;
}

// ─── generation ──────────────────────────────────────────────
async function preUploadBrandAssets(): Promise<void> {
  await Promise.all(
    brandAssets
      .filter((a) => a.source === 'upload' && a.base64 && !a.mediaId)
      .map(async (a) => {
        const mediaId = await uploadAsset(a);
        if (mediaId) { a.mediaId = mediaId; a.base64 = undefined; }
      }),
  );
  save(); renderBrandAssets();
}

async function generateOne(p: Product): Promise<void> {
  p.status = 'running'; p.progress = 'Chuẩn bị…'; p.error = undefined; p.outputs = [];
  renderProductEl(document.querySelector(`[data-prod-id="${p.id}"]`)!, p);
  updateFooter();

  // Ensure product has a mediaId (upload if local)
  if (!p.mediaId && p.base64) {
    p.progress = 'Upload ảnh sản phẩm…';
    renderProductEl(document.querySelector(`[data-prod-id="${p.id}"]`)!, p);
    const result: { mediaId?: string } = await new Promise((resolve) =>
      chrome.runtime.sendMessage({
        type: 'UPLOAD_IMAGE',
        ref: { source: 'upload', base64: p.base64, mime: p.mime || 'image/jpeg', name: p.name },
        projectId: selProjectId || undefined,
        workflowId: selWorkflowId || undefined,
      }, resolve),
    );
    if (result?.mediaId) { p.mediaId = result.mediaId; p.base64 = undefined; }
  }

  if (!p.mediaId && !p.base64) {
    p.status = 'failed'; p.error = 'Không có ảnh sản phẩm';
    renderProductEl(document.querySelector(`[data-prod-id="${p.id}"]`)!, p); updateFooter(); return;
  }

  // Build refs: [product, ...brand assets]
  const productRef = p.mediaId
    ? { source: 'project' as const, mediaId: p.mediaId }
    : { source: 'upload' as const, base64: p.base64!, mime: p.mime || 'image/jpeg' };

  const brandRefs = brandAssets.filter((a) => a.mediaId).slice(0, 8)
    .map((a) => ({ source: 'project' as const, mediaId: a.mediaId! }));

  const refs = [productRef, ...brandRefs];

  const prompt = config.promptTemplate
    .replace(/\{brand_name\}/g, config.brandName)
    .replace(/\{brand_desc\}/g, config.brandDesc);

  const params = {
    mediaType: 'image' as const,
    prompt,
    model: config.model,
    orientation: config.orientation,
    count: config.count,
    maxAttempts: config.maxAttempts,
    references: refs,
    clientId: p.id,
    projectId: selProjectId || undefined,
    workflowId: selWorkflowId || undefined,
  };

  p.progress = 'Đang generate…';
  renderProductEl(document.querySelector(`[data-prod-id="${p.id}"]`)!, p);

  try {
    const result = await new Promise<GenResult>((resolve, reject) =>
      chrome.runtime.sendMessage({ type: 'GENERATE', params }, (r?: GenResult) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!r) reject(new Error('No result'));
        else resolve(r);
      }),
    );
    if (result.ok && result.media.length > 0) {
      p.status = 'done';
      p.outputs = result.media.map((m) => ({ url: m.url || m.dataUri || '' })).filter((o) => o.url);
      p.progress = `${p.outputs.length} ảnh · ${result.attempts || '?'} lần`;
    } else {
      p.status = 'failed'; p.error = result.error || 'Thất bại';
    }
  } catch (e) {
    p.status = 'failed'; p.error = (e as Error).message;
  }

  const el = document.querySelector<HTMLElement>(`[data-prod-id="${p.id}"]`);
  if (el) renderProductEl(el, p);
  updateFooter(); save();
}

async function generateAll(): Promise<void> {
  if (running) return;
  running = true; cancelled = false;
  updateFooter();

  // Ensure a fresh token before uploading/generating (avoids first-attempt 401).
  await new Promise<void>((resolve) =>
    chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => resolve()),
  );
  fetchStatus();

  await preUploadBrandAssets();

  const queue = products.filter((p) => p.status !== 'done');
  if (!queue.length) { running = false; updateFooter(); return; }

  let active = 0;
  await new Promise<void>((resolve) => {
    function next() {
      if (!queue.length && active === 0) { resolve(); return; }
      while (active < CONCURRENCY && queue.length && !cancelled) {
        const p = queue.shift()!;
        active++;
        generateOne(p).finally(() => { active--; next(); });
      }
      if (cancelled && active === 0) resolve();
    }
    next();
  });

  running = false; cancelled = false; updateFooter();
}

// ─── project / workflow ──────────────────────────────────────
function populateProjects(): void {
  chrome.runtime.sendMessage({ type: 'GET_PROJECTS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const sel = $<HTMLSelectElement>('bs-project')!;
    const projects = (data.projects as { projectId: string; title: string }[]) || [];
    sel.innerHTML =
      '<option value="">(tab hiện tại)</option>' +
      projects.map((p) => `<option value="${escHtml(p.projectId)}">${escHtml(p.title)}</option>`).join('');
    sel.value = selProjectId || '';
    if (selProjectId) loadWorkflows(selProjectId);
  });
}

function loadWorkflows(pid: string): void {
  const sel = $<HTMLSelectElement>('bs-workflow')!;
  sel.innerHTML = '<option value="">(mặc định)</option>';
  chrome.runtime.sendMessage({ type: 'GET_WORKFLOWS', projectId: pid }, (data) => {
    const wfs: { workflowId: string; count: number }[] =
      (!chrome.runtime.lastError && data?.workflows) || [];
    wfs.forEach((w) => {
      const opt = document.createElement('option');
      opt.value = w.workflowId;
      opt.textContent = `${w.workflowId.slice(0, 8)}… (${w.count})`;
      sel.appendChild(opt);
    });
    sel.value = selWorkflowId || '';
  });
}

function fetchStatus(): void {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const el = $('bs-token')!;
    const ageMs = data.tokenAge || 0;
    if (data.flowKeyPresent) {
      const ageMin = Math.round(ageMs / 60000);
      if (ageMs > 3_600_000) { el.textContent = `⚠ Token cũ ${ageMin}m — đang refresh…`; el.className = 'warn'; }
      else { el.textContent = `● Token OK (${ageMin}m)`; el.className = 'ok'; }
      // Proactively refresh before the ~1h Google access-token expiry.
      if (ageMs > 3_300_000) chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    } else if (!data.hasFlowTab) {
      el.textContent = '○ Chưa có token — đang mở Flow…'; el.className = 'bad';
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    } else {
      el.textContent = '○ Chưa có token — đang lấy…'; el.className = 'bad';
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    }
  });
}

// ─── init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  applyConfigToInputs();
  render();
  renderBrandAssets();
  // Kick off token capture immediately, then read status shortly after.
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => {
    if (chrome.runtime.lastError) return;
    setTimeout(fetchStatus, 800);
  });
  fetchStatus();
  populateProjects();

  // Drop zone
  const dropZone = $('bs-dropzone')!;
  const prodFile = $<HTMLInputElement>('bs-prod-file')!;
  const brandFile = $<HTMLInputElement>('bs-brand-file')!;
  const pickerFile = $<HTMLInputElement>('bs-picker-file')!;

  dropZone.addEventListener('click', () => prodFile.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer?.files.length) void addProductFiles(e.dataTransfer.files);
  });
  prodFile.addEventListener('change', () => {
    if (prodFile.files?.length) void addProductFiles(prodFile.files);
    prodFile.value = '';
  });

  brandFile.addEventListener('change', () => {
    if (brandFile.files?.length) void addBrandAssetFiles(brandFile.files);
    brandFile.value = '';
  });

  pickerFile.addEventListener('change', () => {
    if (!pickerFile.files?.length) return;
    if (pickerTarget === 'product') void addProductFiles(pickerFile.files);
    else void addBrandAssetFiles(pickerFile.files);
    pickerFile.value = '';
  });

  // Action buttons
  $('bs-add-from-project')!.addEventListener('click', () => openPicker('product'));
  $('bs-brand-add-local')!.addEventListener('click', () => brandFile.click());
  $('bs-brand-add-project')!.addEventListener('click', () => openPicker('brand'));
  $('bs-generate')!.addEventListener('click', () => void generateAll());
  $('bs-stop')!.addEventListener('click', () => { cancelled = true; });

  // Picker modal
  $('bs-picker-close')!.addEventListener('click', closePicker);
  $('bs-picker-done')!.addEventListener('click', closePicker);
  $('bs-picker-modal')!.addEventListener('click', (e) => { if (e.target === e.currentTarget) closePicker(); });
  $('bs-picker-upload')!.addEventListener('click', () => pickerFile.click());

  // Config live-save
  ($('bs-brand-name') as HTMLInputElement).addEventListener('input', () => { config.brandName = ($('bs-brand-name') as HTMLInputElement).value; save(); });
  ($('bs-brand-desc') as HTMLTextAreaElement).addEventListener('input', () => { config.brandDesc = ($('bs-brand-desc') as HTMLTextAreaElement).value; save(); });
  ($('bs-prompt-template') as HTMLTextAreaElement).addEventListener('input', () => { config.promptTemplate = ($('bs-prompt-template') as HTMLTextAreaElement).value; save(); });
  ($('bs-model') as HTMLSelectElement).addEventListener('change', () => { config.model = ($('bs-model') as HTMLSelectElement).value; save(); });
  ($('bs-orient') as HTMLSelectElement).addEventListener('change', () => { config.orientation = ($('bs-orient') as HTMLSelectElement).value as Config['orientation']; save(); });
  ($('bs-count') as HTMLInputElement).addEventListener('change', () => { config.count = Math.max(1, Math.min(4, Number(($('bs-count') as HTMLInputElement).value))); save(); });
  ($('bs-attempts') as HTMLInputElement).addEventListener('change', () => { config.maxAttempts = Math.max(1, Number(($('bs-attempts') as HTMLInputElement).value)); save(); });

  // Project / workflow
  $('bs-project')!.addEventListener('change', () => {
    selProjectId = ($<HTMLSelectElement>('bs-project'))!.value;
    save();
    if (selProjectId) loadWorkflows(selProjectId);
  });
  $('bs-workflow')!.addEventListener('change', () => {
    selWorkflowId = ($<HTMLSelectElement>('bs-workflow'))!.value;
    save();
  });

  // Progress messages pushed from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GEN_PROGRESS' && msg.progress?.clientId) {
      const p = products.find((x) => x.id === msg.progress.clientId);
      if (p && p.status === 'running') {
        p.progress = msg.progress.message;
        const el = document.querySelector<HTMLElement>(`[data-prod-id="${p.id}"]`);
        if (el) renderProductEl(el, p);
      }
    }
    if (msg?.type === 'STATUS_PUSH') { fetchStatus(); populateProjects(); }
  });

  setInterval(() => { fetchStatus(); }, 15000);
});

function applyConfigToInputs(): void {
  ($('bs-brand-name') as HTMLInputElement).value = config.brandName;
  ($('bs-brand-desc') as HTMLTextAreaElement).value = config.brandDesc;
  ($('bs-prompt-template') as HTMLTextAreaElement).value = config.promptTemplate;
  ($('bs-model') as HTMLSelectElement).value = config.model;
  ($('bs-orient') as HTMLSelectElement).value = config.orientation;
  ($('bs-count') as HTMLInputElement).value = String(config.count);
  ($('bs-attempts') as HTMLInputElement).value = String(config.maxAttempts);
}

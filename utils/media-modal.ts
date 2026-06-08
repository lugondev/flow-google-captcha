/**
 * Shared media-management modal — lists all media of the current Flow
 * project/workflow with select + download-all / download-selected / copy-selected.
 * Self-injects its DOM and styles so both the side panel and the batch page can
 * just call openMediaModal().
 */

interface MediaItem {
  mediaId: string;
  type: 'image' | 'video';
  url?: string;
  prompt?: string;
}

let root: HTMLElement | null = null;
let media: MediaItem[] = [];
const selected = new Set<string>();
let scope: 'workflow' | 'project' = 'project';
let projectIdOverride: string | undefined; // when opened from a switched batch project

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root!.querySelector(sel) as T;

function injectStyles(): void {
  if (document.getElementById('mm-styles')) return;
  const css = `
  .mm-overlay { position: fixed; inset: 0; background: rgba(5,5,15,.72); backdrop-filter: blur(2px); z-index: 9999; display: none; align-items: center; justify-content: center; }
  .mm-overlay.open { display: flex; }
  .mm-panel { width: 880px; max-width: 94vw; max-height: 88vh; background: var(--card,#1c1c3a); border: 1px solid var(--border,#2a2a4d); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.5); color: var(--text,#e6e8f5); font-family: var(--font, sans-serif); }
  .mm-head { display: flex; align-items: center; gap: 12px; padding: 13px 16px; background: var(--surface,#14142b); border-bottom: 1px solid var(--border,#2a2a4d); font-weight: 700; font-size: 14px; }
  .mm-head .mm-close { margin-left: auto; background: none; border: none; color: var(--muted,#8b8fb0); cursor: pointer; font-size: 20px; line-height: 1; }
  .mm-head .mm-close:hover { color: var(--text,#e6e8f5); }
  .mm-scope { display: flex; gap: 2px; background: var(--card,#1c1c3a); border: 1px solid var(--border,#2a2a4d); border-radius: 7px; padding: 2px; }
  .mm-scope button { padding: 4px 10px; font-size: 11px; font-weight: 600; border: none; background: none; color: var(--muted,#8b8fb0); border-radius: 5px; cursor: pointer; }
  .mm-scope button.on { background: linear-gradient(135deg,#6366f1,#3b82f6); color: #fff; }
  .mm-toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border,#2a2a4d); background: var(--surface,#14142b); font-size: 12px; flex-wrap: wrap; }
  .mm-toolbar label { display: flex; align-items: center; gap: 6px; color: var(--muted,#8b8fb0); cursor: pointer; }
  .mm-count { color: var(--muted,#8b8fb0); }
  .mm-spacer { margin-left: auto; }
  .mm-btn { padding: 7px 12px; font-size: 11.5px; font-weight: 600; border: 1px solid var(--border,#2a2a4d); border-radius: 7px; background: var(--card,#1c1c3a); color: var(--text,#e6e8f5); cursor: pointer; }
  .mm-btn:hover:not(:disabled) { border-color: var(--accent,#6366f1); color: var(--accent,#6366f1); }
  .mm-btn.primary { background: linear-gradient(135deg,#6366f1,#3b82f6); border-color: transparent; color: #fff; }
  .mm-btn.primary:hover:not(:disabled) { filter: brightness(1.08); color: #fff; }
  .mm-btn:disabled { opacity: .45; cursor: default; }
  .mm-grid { padding: 14px 16px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .mm-tile { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; border: 2px solid transparent; cursor: pointer; background: #000; }
  .mm-tile.sel { border-color: var(--accent,#6366f1); }
  .mm-tile img, .mm-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mm-tile .mm-check { position: absolute; top: 5px; left: 5px; width: 18px; height: 18px; border-radius: 4px; background: rgba(0,0,0,.6); border: 1px solid #fff; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; }
  .mm-tile.sel .mm-check { background: var(--accent,#6366f1); border-color: var(--accent,#6366f1); }
  .mm-tile .mm-vid { position: absolute; bottom: 4px; right: 4px; font-size: 10px; background: rgba(0,0,0,.6); padding: 1px 5px; border-radius: 4px; }
  .mm-tile .mm-acts { position: absolute; bottom: 4px; left: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
  .mm-tile:hover .mm-acts { opacity: 1; }
  .mm-acts button { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; border: none; border-radius: 5px; background: rgba(0,0,0,.7); color: #fff; cursor: pointer; }
  .mm-acts button:hover { background: var(--accent,#6366f1); }
  .mm-empty { grid-column: 1/-1; padding: 30px; text-align: center; color: var(--muted,#8b8fb0); font-size: 12px; }`;
  const style = document.createElement('style');
  style.id = 'mm-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureDom(): void {
  if (root) return;
  injectStyles();
  root = document.createElement('div');
  root.className = 'mm-overlay';
  root.innerHTML = `
    <div class="mm-panel">
      <div class="mm-head">
        <span>📁 Media của project</span>
        <div class="mm-scope">
          <button data-scope="workflow">Workflow</button>
          <button data-scope="project">Toàn project</button>
        </div>
        <button class="mm-close" title="Đóng">&times;</button>
      </div>
      <div class="mm-toolbar">
        <label><input type="checkbox" class="mm-all" /> Chọn tất cả</label>
        <span class="mm-count">0 đã chọn</span>
        <span class="mm-spacer"></span>
        <button class="mm-btn primary mm-dl-all">⬇ Tải tất cả</button>
        <button class="mm-btn mm-dl-sel" disabled>⬇ Tải đã chọn</button>
        <button class="mm-btn mm-copy-sel" disabled>⧉ Copy ảnh đã chọn</button>
      </div>
      <div class="mm-grid"><div class="mm-empty">Đang tải…</div></div>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  $('.mm-close').addEventListener('click', close);
  root.querySelectorAll<HTMLElement>('.mm-scope button').forEach((b) =>
    b.addEventListener('click', () => { scope = b.getAttribute('data-scope') as typeof scope; load(); }),
  );
  $<HTMLInputElement>('.mm-all').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    selected.clear();
    if (on) media.forEach((m) => selected.add(m.mediaId));
    renderGrid();
  });
  $('.mm-dl-all').addEventListener('click', () => downloadItems(media));
  $('.mm-dl-sel').addEventListener('click', () => downloadItems(media.filter((m) => selected.has(m.mediaId))));
  $('.mm-copy-sel').addEventListener('click', copySelected);
}

function reflectScope(): void {
  root!.querySelectorAll<HTMLElement>('.mm-scope button').forEach((b) =>
    b.classList.toggle('on', b.getAttribute('data-scope') === scope),
  );
}

function updateButtons(): void {
  const n = selected.size;
  $('.mm-count').textContent = `${n} đã chọn`;
  ($('.mm-dl-sel') as HTMLButtonElement).disabled = n === 0;
  ($('.mm-copy-sel') as HTMLButtonElement).disabled = n === 0;
  ($('.mm-dl-all') as HTMLButtonElement).disabled = media.length === 0;
}

function renderGrid(): void {
  const grid = $('.mm-grid');
  if (!media.length) { grid.innerHTML = '<div class="mm-empty">Không có media (hoặc chưa mở tab Flow).</div>'; updateButtons(); return; }
  grid.innerHTML = media.map((m) => {
    const sel = selected.has(m.mediaId) ? ' sel' : '';
    const inner = m.url
      ? (m.type === 'video' ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}" loading="lazy" />`)
      : `<div class="mm-empty" style="padding:6px;font-size:8px">${esc((m.prompt || m.mediaId).slice(0, 30))}</div>`;
    const vid = m.type === 'video' ? '<span class="mm-vid">▶</span>' : '';
    const acts = m.url
      ? `<div class="mm-acts">${m.type === 'image' ? '<button data-act="copy-img" title="Copy ảnh">⧉</button>' : ''}<button data-act="copy-url" title="Copy URL">🔗</button></div>`
      : '';
    return `<div class="mm-tile${sel}" data-id="${esc(m.mediaId)}">${inner}<span class="mm-check">${sel ? '✓' : ''}</span>${vid}${acts}</div>`;
  }).join('');
  grid.querySelectorAll<HTMLElement>('.mm-tile').forEach((t) =>
    t.addEventListener('click', (e) => {
      const id = t.getAttribute('data-id')!;
      const actEl = (e.target as HTMLElement).closest('[data-act]') as HTMLButtonElement | null;
      if (actEl) { e.stopPropagation(); void tileAction(actEl, actEl.getAttribute('data-act')!, id); return; }
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      renderGrid();
    }),
  );
  ($('.mm-all') as HTMLInputElement).checked = media.length > 0 && selected.size === media.length;
  updateButtons();
}

function load(): void {
  reflectScope();
  $('.mm-grid').innerHTML = '<div class="mm-empty">Đang tải…</div>';
  selected.clear();
  chrome.runtime.sendMessage({ type: 'GET_PROJECT_MEDIA', scope, projectId: projectIdOverride }, (data) => {
    if (chrome.runtime.lastError || !data) { media = []; $('.mm-grid').innerHTML = `<div class="mm-empty">Lỗi: ${esc(chrome.runtime.lastError?.message || 'no data')}</div>`; updateButtons(); return; }
    if (data.error) { media = []; $('.mm-grid').innerHTML = `<div class="mm-empty">${esc(data.error)}</div>`; updateButtons(); return; }
    media = (data.media as MediaItem[]) || [];
    // Reflect the scope actually served: requesting 'workflow' may fall back to
    // the whole project when the workflow has no media (background sets scoped).
    if (typeof data.scoped === 'boolean') { scope = data.scoped ? 'workflow' : 'project'; reflectScope(); }
    renderGrid();
  });
}

function fileName(m: MediaItem): string {
  const base = (m.url || '').split('?')[0] || '';
  const ext = (base.match(/\.(png|jpe?g|webp|mp4|webm|gif)$/i)?.[1] || (m.type === 'video' ? 'mp4' : 'png')).toLowerCase();
  return `flow-${m.mediaId}.${ext}`;
}

function downloadItems(items: MediaItem[]): void {
  const withUrl = items.filter((m) => m.url);
  if (!withUrl.length) return;
  for (const m of withUrl) {
    chrome.downloads.download({ url: m.url!, filename: fileName(m), saveAs: false }).catch(() => {});
  }
}

function blobToDataUri(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function copySelected(): Promise<void> {
  const btn = $('.mm-copy-sel') as HTMLButtonElement;
  const imgs = media.filter((m) => selected.has(m.mediaId) && m.type === 'image' && m.url);
  if (!imgs.length) { btn.textContent = 'Không có ảnh để copy'; setTimeout(() => (btn.textContent = '⧉ Copy ảnh đã chọn'), 1800); return; }
  const orig = '⧉ Copy ảnh đã chọn';
  btn.textContent = 'Đang copy…'; btn.disabled = true;

  // The OS clipboard holds only ONE raster image, so we write two reps in one
  // ClipboardItem: image/png (first image, for image-only paste targets) and
  // text/html with ALL selected images as data-URIs (Docs/Gmail/Slides paste them all).
  // Promises keep the user-gesture chain alive while we fetch/convert.
  const pngBlob = (async () => toPng(await (await fetch(imgs[0]!.url!)).blob()))();
  const htmlBlob = (async () => {
    const tags = await Promise.all(
      imgs.map(async (m) => `<img src="${await blobToDataUri(await (await fetch(m.url!)).blob())}" />`),
    );
    return new Blob([tags.join('')], { type: 'text/html' });
  })();

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob, 'text/html': htmlBlob })]);
    btn.textContent = imgs.length > 1 ? `✓ Copy ${imgs.length} ảnh (paste Docs/Gmail ra hết)` : '✓ Đã copy';
  } catch (e) {
    btn.textContent = 'Copy lỗi: ' + ((e as Error).message || '').slice(0, 30);
  }
  setTimeout(() => { btn.textContent = orig; updateButtons(); }, 2400);
}

async function tileAction(btn: HTMLButtonElement, act: string, id: string): Promise<void> {
  const m = media.find((x) => x.mediaId === id);
  if (!m?.url) return;
  const orig = btn.textContent;
  try {
    if (act === 'copy-url') {
      await navigator.clipboard.writeText(m.url);
    } else {
      // Promise<Blob> keeps the click gesture alive through fetch/convert.
      const png = (async () => toPng(await (await fetch(m.url!)).blob()))();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
    btn.textContent = '✓';
  } catch {
    btn.textContent = '✗';
  }
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

function close(): void { root?.classList.remove('open'); }

export function openMediaModal(projectId?: string, initialScope: 'workflow' | 'project' = 'workflow'): void {
  ensureDom();
  projectIdOverride = projectId;
  scope = initialScope;
  root!.classList.add('open');
  load();
}

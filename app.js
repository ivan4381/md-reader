(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('mdr:' + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mdr:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('mdr:' + k); } catch {} }
};
const encPath = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const MD_RE = /\.(md|markdown|mdx|mkd)$/i;
const link = o => '#' + new URLSearchParams(o).toString();
const baseName = p => p.split('/').pop() || p;

const el = {
  bar: $('#bar'), back: $('#back'), title: $('#title'), toc: $('#tocBtn'), menu: $('#menuBtn'),
  view: $('#view'), wrap: $('#sheetWrap'), sheet: $('#sheet'), backdrop: $('#backdrop'), toast: $('#toast')
};

let rid = 0;          // token navigasi (anti race)
let navs = 0;         // jumlah navigasi di dalam app
let localDoc = null;  // file lokal yang sedang dibuka
let currentCtx = null;// konteks halaman aktif untuk menu
let installEvt = null;

/* ---------- tema & font ---------- */
function applyPrefs() {
  const t = store.get('theme', 'auto');
  document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty('--fs', store.get('fs', 17) + 'px');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = dark ? '#0d1117' : '#ffffff';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);

function toast(msg) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.toast.hidden = true, 2200);
}

/* ---------- cache offline (Cache API) ---------- */
const CACHE = 'mdr-data-v1';
async function cachePut(key, text) { try { const c = await caches.open(CACHE); await c.put('/_c/' + encodeURIComponent(key), new Response(text)); } catch {} }
async function cacheGet(key) { try { const c = await caches.open(CACHE); const r = await c.match('/_c/' + encodeURIComponent(key)); return r ? await r.text() : null; } catch { return null; } }

/* ---------- GitHub API ---------- */
async function gh(path, { raw = false, blob = false } = {}) {
  const token = store.get('token', '');
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('https://api.github.com' + path, { headers });
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).message || ''; } catch {}
    const e = new Error(m || ('HTTP ' + r.status)); e.status = r.status; e.ghMessage = m;
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') e.rate = true;
    throw e;
  }
  return blob ? r.blob() : raw ? r.text() : r.json();
}
// ambil dari jaringan; kalau offline, pakai cache
async function ghc(key, path, raw = false) {
  try {
    const d = await gh(path, { raw });
    cachePut(key, raw ? d : JSON.stringify(d));
    return { d, off: false };
  } catch (e) {
    if (e.status) throw e;
    const c = await cacheGet(key);
    if (c != null) return { d: raw ? c : JSON.parse(c), off: true };
    throw e;
  }
}
function friendlyError(e) {
  const hasTok = !!store.get('token', '');
  if (e.rate) return 'Batas request GitHub tercapai. Hubungkan akun dengan token (menu ⋯ → Token GitHub) agar limit jauh lebih besar.';
  if (e.status === 401) return 'Token tidak valid atau kedaluwarsa. Perbarui di menu ⋯ → Token GitHub.';
  if (e.status === 404) return hasTok ? 'Tidak ditemukan. Cek nama repo/branch/path, atau pastikan token punya akses ke repo ini.' : 'Tidak ditemukan. Kalau repo ini private, hubungkan token di menu ⋯ → Token GitHub.';
  if (e.status === 403) return 'Akses ditolak: ' + (e.ghMessage || 'periksa izin token.');
  if (!e.status) return 'Tidak bisa terhubung ke GitHub dan belum ada salinan offline.';
  return e.message;
}

function parseGH(s) {
  s = (s || '').trim().replace(/\.git$/, '');
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:\/(blob|tree)\/(.+?))?(?:[#?].*)?$/);
  if (m) {
    const [, o, r, kind, rest] = m;
    if (!kind) return { o, r };
    const parts = rest.split('/').map(decodeURIComponent);
    return { o, r, ref: parts[0], p: parts.slice(1).join('/'), kind };
  }
  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { o: m[1], r: m[2] } : null;
}

async function defaultBranch(o, r) {
  const { d } = await ghc(`info:${o}/${r}`, `/repos/${o}/${r}`);
  return d.default_branch;
}

/* ---------- bar & sheet ---------- */
function setBar({ title, back = false, toc = false }) {
  el.title.textContent = title; document.title = title + ' · MD Reader';
  el.back.hidden = !back; el.toc.hidden = !toc;
}
function openSheet(html) { el.sheet.innerHTML = html; el.wrap.hidden = false; return el.sheet; }
function closeSheet() { el.wrap.hidden = true; el.sheet.innerHTML = ''; }
el.backdrop.onclick = closeSheet;

el.back.onclick = () => {
  if (navs > 0) return history.back();
  const c = currentCtx || {};
  if (c.v === 'file' || c.v === 'local') {
    if (c.v === 'file') { const dir = c.p.split('/').slice(0, -1).join('/'); location.hash = link({ v: 'repo', o: c.o, r: c.r, ref: c.ref, p: dir }); }
    else location.hash = '';
  } else if (c.v === 'repo' && c.p) {
    location.hash = link({ v: 'repo', o: c.o, r: c.r, ref: c.ref, p: c.p.split('/').slice(0, -1).join('/') });
  } else location.hash = '';
};

/* ---------- routing ---------- */
const posStore = () => store.get('pos', {});
let curKey = null;
function saveScroll() { if (curKey) { const p = posStore(); p[curKey] = scrollY; const k = Object.keys(p); if (k.length > 80) delete p[k[0]]; store.set('pos', p); } }

async function route() {
  saveScroll();
  closeSheet();
  const q = new URLSearchParams(location.hash.slice(1));
  const v = q.get('v') || 'home';
  const P = { v, o: q.get('o') || '', r: q.get('r') || '', ref: q.get('ref') || '', p: q.get('p') || '' };
  curKey = location.hash; currentCtx = P;
  const id = ++rid;
  try {
    if (v === 'repo') await viewRepo(P, id);
    else if (v === 'file') await viewFile(P, id);
    else if (v === 'local') viewLocal();
    else viewHome();
  } catch (e) {
    if (id !== rid) return;
    el.view.innerHTML = `<div class="err"><b>Gagal membuka</b><p>${esc(friendlyError(e))}</p><p class="mut">${esc(e.message || '')}</p></div>`;
  }
}
window.addEventListener('hashchange', () => { navs++; route(); });

/* ---------- Home ---------- */
function viewHome() {
  setBar({ title: 'MD Reader' });
  const tok = store.get('token', '');
  const favs = store.get('favs', []);
  const recents = store.get('recents', []);
  el.view.innerHTML = `
  <section class="card">
    <h2>Buka dari GitHub</h2>
    <form id="f"><input id="src" type="text" placeholder="owner/repo atau link GitHub" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"><button class="pri">Buka</button></form>
    <p class="mut" style="margin:10px 0 0">${tok ? '✓ Terhubung dengan token — repo private bisa dibuka.' : 'Tanpa token hanya repo publik. <a href="#" id="addTok">Hubungkan akun GitHub</a>'}</p>
  </section>
  <section class="card"><button class="sec" id="pick" style="margin:0">📂 Buka file .md dari HP</button>
    <input type="file" id="file" accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain" hidden></section>
  ${favs.length ? `<div class="sectionh">Repo favorit</div><ul class="list">${favs.map(f => `<li><a href="${link({ v: 'repo', o: f.o, r: f.r })}"><span>⭐</span><span class="n">${esc(f.o)}/<b>${esc(f.r)}</b></span></a></li>`).join('')}</ul>` : ''}
  ${recents.length ? `<div class="sectionh">Terakhir dibuka</div><ul class="list">${recents.slice(0, 10).map(x => `<li><a href="${link({ v: 'file', o: x.o, r: x.r, ref: x.ref, p: x.p })}"><span>📄</span><span class="n">${esc(baseName(x.p))}<div class="s">${esc(x.o)}/${esc(x.r)} · ${esc(x.p)}</div></span></a></li>`).join('')}</ul>` : ''}
  <div id="mine"></div>`;
  $('#f').onsubmit = ev => {
    ev.preventDefault();
    const g = parseGH($('#src').value);
    if (!g) return toast('Format: owner/repo atau link GitHub');
    if (g.kind === 'blob' && MD_RE.test(g.p)) location.hash = link({ v: 'file', o: g.o, r: g.r, ref: g.ref, p: g.p });
    else location.hash = link({ v: 'repo', o: g.o, r: g.r, ref: g.ref || '', p: g.p || '' });
  };
  const at = $('#addTok'); if (at) at.onclick = e => { e.preventDefault(); tokenSheet(); };
  $('#pick').onclick = () => $('#file').click();
  $('#file').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    localDoc = { name: f.name, text: await f.text() };
    location.hash = link({ v: 'local' });
  };
  if (tok) loadMine(rid);
}

async function loadMine(id) {
  const box = $('#mine'); if (!box) return;
  try {
    const { d } = await ghc('myrepos', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    if (id !== rid || !$('#mine')) return;
    box.innerHTML = `<div class="sectionh">Repo kamu</div><ul class="list">${d.map(x => `<li><a href="${link({ v: 'repo', o: x.owner.login, r: x.name, ref: x.default_branch })}"><span>${x.private ? '🔒' : '📁'}</span><span class="n">${esc(x.full_name)}${x.description ? `<div class="s">${esc(x.description)}</div>` : ''}</span></a></li>`).join('')}</ul>`;
  } catch (e) { box.innerHTML = `<p class="mut">Gagal memuat daftar repo: ${esc(friendlyError(e))}</p>`; }
}

/* ---------- Repo / folder ---------- */
async function viewRepo(P, id) {
  setBar({ title: `${P.o}/${P.r}`, back: true });
  el.view.innerHTML = '<div class="spin">Memuat…</div>';
  let ref = P.ref;
  if (!ref) {
    ref = await defaultBranch(P.o, P.r);
    if (id !== rid) return;
    history.replaceState(null, '', link({ v: 'repo', o: P.o, r: P.r, ref, p: P.p }));
    currentCtx = curKey && { ...P, ref }; curKey = location.hash;
  }
  const p = P.p.replace(/^\/|\/$/g, '');
  const apiPath = `/repos/${P.o}/${P.r}/contents${p ? '/' + encPath(p) : ''}?ref=${encodeURIComponent(ref)}`;
  const [dir, br] = await Promise.all([
    ghc(`dir:${P.o}/${P.r}@${ref}:${p}`, apiPath),
    ghc(`br:${P.o}/${P.r}`, `/repos/${P.o}/${P.r}/branches?per_page=100`).catch(() => null)
  ]);
  if (id !== rid) return;
  if (!Array.isArray(dir.d)) { location.replace(link({ v: 'file', o: P.o, r: P.r, ref, p })); return; }
  currentCtx = { ...P, ref, p };
  const items = dir.d.filter(x => x.type === 'dir' || MD_RE.test(x.name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  const parts = p ? p.split('/') : [];
  const crumbs = [`<a href="${link({ v: 'repo', o: P.o, r: P.r, ref })}">${esc(P.r)}</a>`]
    .concat(parts.map((seg, i) => `<span>›</span><a href="${link({ v: 'repo', o: P.o, r: P.r, ref, p: parts.slice(0, i + 1).join('/') })}">${esc(seg)}</a>`));
  const favs = store.get('favs', []); const isFav = favs.some(f => f.o === P.o && f.r === P.r);
  const branches = br ? br.d.map(b => b.name) : [ref];
  if (!branches.includes(ref)) branches.unshift(ref);
  el.view.innerHTML = `
    <div class="row2"><select id="br" aria-label="Branch">${branches.map(b => `<option ${b === ref ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
    <button class="fav fix" id="fav" aria-label="Favorit">${isFav ? '⭐' : '☆'}</button></div>
    <div class="crumbs">${crumbs.join(' ')} ${dir.off ? '<span class="badge">offline</span>' : ''}</div>
    <input type="search" id="flt" placeholder="Filter nama…" style="margin-bottom:10px">
    <ul class="list" id="ls">${items.map(x => x.type === 'dir'
      ? `<li data-n="${esc(x.name.toLowerCase())}"><a href="${link({ v: 'repo', o: P.o, r: P.r, ref, p: x.path })}"><span>📁</span><span class="n">${esc(x.name)}</span></a></li>`
      : `<li data-n="${esc(x.name.toLowerCase())}"><a href="${link({ v: 'file', o: P.o, r: P.r, ref, p: x.path })}"><span>📄</span><span class="n">${esc(x.name)}</span><span class="s">${(x.size / 1024).toFixed(x.size < 10240 ? 1 : 0)} KB</span></a></li>`).join('')}</ul>
    ${items.length ? '' : '<p class="mut">Tidak ada file .md atau subfolder di sini.</p>'}`;
  $('#br').onchange = e => { location.hash = link({ v: 'repo', o: P.o, r: P.r, ref: e.target.value }); };
  $('#fav').onclick = () => {
    let f = store.get('favs', []);
    if (f.some(x => x.o === P.o && x.r === P.r)) f = f.filter(x => !(x.o === P.o && x.r === P.r)); else f.unshift({ o: P.o, r: P.r });
    store.set('favs', f); $('#fav').textContent = f.some(x => x.o === P.o && x.r === P.r) ? '⭐' : '☆';
  };
  $('#flt').oninput = e => { const t = e.target.value.toLowerCase(); document.querySelectorAll('#ls li').forEach(li => li.hidden = !li.dataset.n.includes(t)); };
}

/* ---------- File ---------- */
async function viewFile(P, id) {
  const name = baseName(P.p);
  setBar({ title: name, back: true });
  el.view.innerHTML = '<div class="spin">Memuat…</div>';
  let ref = P.ref;
  if (!ref) {
    ref = await defaultBranch(P.o, P.r); if (id !== rid) return;
    history.replaceState(null, '', link({ v: 'file', o: P.o, r: P.r, ref, p: P.p })); curKey = location.hash;
  }
  currentCtx = { ...P, ref };
  const { d: text, off } = await ghc(`file:${P.o}/${P.r}@${ref}:${P.p}`, `/repos/${P.o}/${P.r}/contents/${encPath(P.p)}?ref=${encodeURIComponent(ref)}`, true);
  if (id !== rid) return;
  const rec = store.get('recents', []).filter(x => !(x.o === P.o && x.r === P.r && x.p === P.p));
  rec.unshift({ o: P.o, r: P.r, ref, p: P.p }); store.set('recents', rec.slice(0, 30));
  const dir = P.p.split('/').slice(0, -1).join('/');
  showDoc(text, { o: P.o, r: P.r, ref, dir }, name, off, `${P.o}/${P.r}@${ref}`);
  const y = posStore()[curKey]; if (y) requestAnimationFrame(() => scrollTo(0, y));
}

function viewLocal() {
  if (!localDoc) { location.hash = ''; return; }
  setBar({ title: localDoc.name, back: true });
  showDoc(localDoc.text, null, localDoc.name, false, 'file lokal');
}

/* ---------- Render markdown ---------- */
function splitFront(md) {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { front: m[1], body: md.slice(m[0].length) } : { front: '', body: md };
}
const slug = t => t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

function resolveRel(href, ctx) {
  // kembalikan path repo untuk link relatif, atau null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let h = href, hash = '';
  const i = h.indexOf('#'); if (i >= 0) { hash = h.slice(i + 1); h = h.slice(0, i); }
  const j = h.indexOf('?'); if (j >= 0) h = h.slice(0, j);
  const base = 'https://x.invalid/' + (h.startsWith('/') ? '' : (ctx.dir ? encPath(ctx.dir) + '/' : ''));
  const u = new URL(h.startsWith('/') ? h.slice(1) : h, base);
  return { path: decodeURIComponent(u.pathname.slice(1)), hash };
}

function renderMd(md, ctx) {
  const { front, body } = splitFront(md);
  let html = marked.parse(body, { gfm: true, breaks: false });
  html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_TAGS: ['details', 'summary'] });
  const box = document.createElement('article'); box.className = 'md'; box.innerHTML = html;

  const seen = {};
  const heads = [...box.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  heads.forEach(h => { let s = slug(h.textContent) || 'bagian'; if (seen[s] != null) s += '-' + (++seen[s]); else seen[s] = 0; h.id = s; });

  box.querySelectorAll('table').forEach(t => { const w = document.createElement('div'); w.className = 'scroll'; t.replaceWith(w); w.appendChild(t); });

  box.querySelectorAll('pre > code').forEach(c => {
    try { hljs.highlightElement(c); } catch {}
    const b = document.createElement('button'); b.className = 'cp'; b.type = 'button'; b.textContent = 'Salin';
    b.onclick = async () => { try { await navigator.clipboard.writeText(c.textContent); b.textContent = 'Tersalin ✓'; setTimeout(() => b.textContent = 'Salin', 1500); } catch { toast('Gagal menyalin'); } };
    c.parentElement.prepend(b);
  });

  box.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) { a.dataset.anchor = decodeURIComponent(href.slice(1)); a.removeAttribute('href'); a.style.cursor = 'pointer'; a.style.color = 'var(--acc)'; a.style.textDecoration = 'underline'; return; }
    const g = /^https?:\/\//i.test(href) ? parseGH(href) : null;
    if (g && g.kind === 'blob' && MD_RE.test(g.p)) { a.setAttribute('href', link({ v: 'file', o: g.o, r: g.r, ref: g.ref, p: g.p })); return; }
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
    if (!ctx || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const r = resolveRel(href, ctx);
    if (r && MD_RE.test(r.path)) a.setAttribute('href', link({ v: 'file', o: ctx.o, r: ctx.r, ref: ctx.ref, p: r.path }));
    else if (r) { a.href = `https://github.com/${ctx.o}/${ctx.r}/blob/${ctx.ref}/${encPath(r.path)}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });

  if (ctx) {
    const token = store.get('token', '');
    box.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src'); img.loading = 'lazy';
      const r = resolveRel(src, ctx); if (!r) return;
      if (token) {
        img.removeAttribute('src');
        gh(`/repos/${ctx.o}/${ctx.r}/contents/${encPath(r.path)}?ref=${encodeURIComponent(ctx.ref)}`, { raw: true, blob: true })
          .then(b => { img.src = URL.createObjectURL(b); }).catch(() => { img.alt = img.alt || '[gambar tidak bisa dimuat]'; });
      } else img.src = `https://raw.githubusercontent.com/${ctx.o}/${ctx.r}/${ctx.ref}/${encPath(r.path)}`;
    });
  }

  box.addEventListener('click', ev => {
    const a = ev.target.closest('a[data-anchor]'); if (!a) return;
    ev.preventDefault();
    const t = [...box.querySelectorAll('[id]')].find(n => n.id === a.dataset.anchor || n.id === slug(a.dataset.anchor));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return { box, heads, front };
}

function showDoc(text, ctx, name, off, where) {
  const { box, heads, front } = renderMd(text, ctx);
  el.view.innerHTML = `<div class="docmeta"><span>${esc(where)}</span>${off ? '<span class="badge">offline</span>' : ''}<span class="pdate ponly"></span></div>`;
  if (front) {
    const d = document.createElement('details'); d.className = 'md fm'; d.style.fontSize = '13px';
    d.innerHTML = '<summary>Front matter</summary><pre><code></code></pre>'; d.querySelector('code').textContent = front; el.view.appendChild(d);
  }
  el.view.appendChild(box);
  el.toc.hidden = heads.length < 2;
  el.toc.onclick = () => {
    openSheet(`<h3>Daftar isi</h3><div class="toc">${heads.map(h => `<a data-id="${esc(h.id)}" style="padding-left:${(+h.tagName[1] - 1) * 14 + 6}px">${esc(h.textContent)}</a>`).join('')}</div>`);
    el.sheet.querySelectorAll('.toc a').forEach(a => a.onclick = () => { closeSheet(); heads.find(h => h.id === a.dataset.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  };
  window.__doc = { text, name };
}

/* ---------- Menu ---------- */
el.menu.onclick = () => {
  const c = currentCtx || {};
  const inFile = c.v === 'file', inDoc = inFile || c.v === 'local';
  const items = [];
  if (inDoc) items.push(['pdf', 'Ekspor ke PDF'], ['copy', 'Salin teks markdown']);
  if (inFile) { items.push(['reload', 'Muat ulang dari GitHub'], ['ghopen', 'Buka di GitHub'], ['share', 'Bagikan link']); }
  items.push(['fs', 'Tampilan & ukuran font'], ['token', 'Token GitHub']);
  if (installEvt) items.push(['install', 'Pasang aplikasi di HP']);
  items.push(['clear', 'Hapus cache offline']);
  openSheet(`<h3>Menu</h3>${items.map(([k, t]) => `<button class="mi" data-k="${k}">${t}</button>`).join('')}`);
  el.sheet.querySelectorAll('.mi').forEach(b => b.onclick = () => menuAct(b.dataset.k));
};

async function menuAct(k) {
  const c = currentCtx || {};
  const ghUrl = `https://github.com/${c.o}/${c.r}/blob/${c.ref}/${encPath(c.p || '')}`;
  if (k === 'copy') { closeSheet(); try { await navigator.clipboard.writeText(window.__doc.text); toast('Tersalin'); } catch { toast('Gagal menyalin'); } }
  else if (k === 'reload') { closeSheet(); try { const c2 = await caches.open(CACHE); await c2.delete('/_c/' + encodeURIComponent(`file:${c.o}/${c.r}@${c.ref}:${c.p}`)); } catch {} route(); }
  else if (k === 'ghopen') { closeSheet(); window.open(ghUrl, '_blank', 'noopener'); }
  else if (k === 'share') { closeSheet(); if (navigator.share) navigator.share({ title: baseName(c.p), url: ghUrl }).catch(() => {}); else { navigator.clipboard?.writeText(ghUrl); toast('Link disalin'); } }
  else if (k === 'pdf') pdfSheet();
  else if (k === 'fs') prefsSheet();
  else if (k === 'token') tokenSheet();
  else if (k === 'install') { closeSheet(); installEvt.prompt(); installEvt = null; }
  else if (k === 'clear') { closeSheet(); try { await caches.delete(CACHE); } catch {} toast('Cache offline dihapus'); }
}

/* ---------- Ekspor PDF (via dialog cetak → Simpan sebagai PDF) ---------- */
const PDF_DEF = { paper: 'A4', margin: 'normal', size: 11, src: true, open: true };
function pdfSheet() {
  const o = { ...PDF_DEF, ...store.get('pdf', {}) };
  const seg = (id, opts, cur) => `<div class="seg" id="${id}">${opts.map(([k, n]) => `<button data-k="${k}" class="${String(cur) === String(k) ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  const s = openSheet(`<h3>Ekspor ke PDF</h3>
    <div class="mut">Kertas</div>${seg('pp', [['A4', 'A4'], ['letter', 'Letter'], ['legal', 'Legal']], o.paper)}
    <div class="mut">Margin</div>${seg('pm', [['narrow', 'Sempit'], ['normal', 'Normal'], ['wide', 'Lebar']], o.margin)}
    <div class="mut">Ukuran teks</div>${seg('ps', [[10, 'Kecil'], [11, 'Sedang'], [13, 'Besar']], o.size)}
    <label class="chk"><input type="checkbox" id="psrc" ${o.src ? 'checked' : ''}> Tampilkan sumber & tanggal di atas</label>
    <label class="chk"><input type="checkbox" id="popen" ${o.open ? 'checked' : ''}> Buka semua blok lipatan (&lt;details&gt;)</label>
    <button class="pri" id="go">Buat PDF</button>
    <p class="mut" style="margin:10px 0 0">Di dialog cetak, pilih printer <b>Simpan sebagai PDF</b>, lalu tekan tombol unduh PDF.</p>`);
  ['pp', 'ps', 'pm'].forEach(id => s.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => {
    s.querySelectorAll(`#${id} button`).forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#go', s).onclick = () => {
    const pick = id => $(`#${id} .on`, s).dataset.k;
    const opts = { paper: pick('pp'), margin: pick('pm'), size: +pick('ps'), src: $('#psrc', s).checked, open: $('#popen', s).checked };
    store.set('pdf', opts); closeSheet(); exportPdf(opts);
  };
}

async function exportPdf(o) {
  if (typeof window.print !== 'function') return toast('Browser ini tidak mendukung cetak/PDF');
  const art = $('#view article.md'); if (!art) return;
  const M = { narrow: '10mm', normal: '18mm', wide: '25mm' }[o.margin] || '18mm';
  let st = $('#printPage'); if (!st) { st = document.createElement('style'); st.id = 'printPage'; document.head.appendChild(st); }
  st.textContent = `@page{size:${o.paper} portrait;margin:${M}}`;
  const root = document.documentElement;
  root.style.setProperty('--pfs', o.size + 'pt');
  root.classList.toggle('pdf-nosrc', !o.src);
  const pd = $('#view .pdate'); if (pd) pd.textContent = 'Diekspor ' + new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

  // buka <details>, pastikan semua gambar termuat (lazy-load tidak jalan saat cetak)
  const closed = o.open ? [...art.querySelectorAll('details:not([open])')] : [];
  closed.forEach(d => d.open = true);
  toast('Menyiapkan PDF…');
  const imgs = [...art.querySelectorAll('img')];
  imgs.forEach(i => i.loading = 'eager');
  await Promise.race([
    Promise.all(imgs.map(i => (i.complete && i.src) ? 0 : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
    new Promise(r => setTimeout(r, 8000))
  ]);
  try { await document.fonts?.ready; } catch {}

  // nama file PDF = judul dokumen
  const oldTitle = document.title;
  document.title = (window.__doc?.name || 'dokumen').replace(/\.(md|markdown|mdx|mkd|txt)$/i, '');
  let done = false;
  const restore = () => { if (done) return; done = true; document.title = oldTitle; closed.forEach(d => d.open = false); };
  window.addEventListener('afterprint', restore, { once: true });
  el.toast.hidden = true;
  window.print();
  setTimeout(restore, 60000); // jaga-jaga bila afterprint tidak terpanggil
}

function prefsSheet() {
  const t = store.get('theme', 'auto'), fs = store.get('fs', 17);
  const s = openSheet(`<h3>Tema</h3><div class="seg" id="th">${[['auto', 'Otomatis'], ['light', 'Terang'], ['dark', 'Gelap']].map(([k, n]) => `<button data-k="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <h3>Ukuran font: <span id="fsv">${fs}</span>px</h3><input type="range" id="fsr" min="13" max="26" value="${fs}" style="width:100%">`);
  s.querySelectorAll('#th button').forEach(b => b.onclick = () => { store.set('theme', b.dataset.k); applyPrefs(); prefsSheet(); });
  $('#fsr', s).oninput = e => { store.set('fs', +e.target.value); $('#fsv', s).textContent = e.target.value; applyPrefs(); };
}

function tokenSheet() {
  const tok = store.get('token', '');
  const s = openSheet(`<h3>Token GitHub</h3>
    <p class="mut">Dipakai untuk membuka repo private dan menaikkan batas request. Disimpan hanya di HP ini. Gunakan <i>fine-grained token</i> dengan izin <b>Contents: Read-only</b>.
    <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Buat token</a></p>
    <input type="password" id="tk" placeholder="github_pat_… atau ghp_…" autocapitalize="off" autocomplete="off" value="${esc(tok)}">
    <button class="pri" id="sv">Simpan & tes</button>
    ${tok ? '<button class="sec" id="rm">Putuskan (hapus token)</button>' : ''}<p class="mut" id="msg"></p>`);
  $('#sv', s).onclick = async () => {
    const v = $('#tk', s).value.trim(); const msg = $('#msg', s);
    if (!v) { msg.textContent = 'Isi token dulu.'; return; }
    store.set('token', v); msg.textContent = 'Menguji…';
    try { const u = await gh('/user'); msg.textContent = `✓ Terhubung sebagai ${u.login}`; setTimeout(() => { closeSheet(); route(); }, 900); }
    catch (e) { store.del('token'); msg.textContent = '✗ ' + friendlyError(e); }
  };
  const rm = $('#rm', s); if (rm) rm.onclick = () => { store.del('token'); closeSheet(); toast('Token dihapus'); route(); };
}

/* ---------- PWA ---------- */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

applyPrefs();
route();
})();

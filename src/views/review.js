/**
 * Listing review queue — behaviour.
 *
 * A separate file rather than an inline <script> because the API sets
 * `script-src 'self'; script-src-attr 'none'`. Inline blocks and inline
 * onclick attributes are both refused, silently: the first version of this page
 * rendered perfectly and did nothing at all. Everything here is wired with
 * addEventListener, and the cards — which are rebuilt on every load — use event
 * delegation off a container that outlives them.
 *
 * The token is pasted by the reviewer and kept in sessionStorage for the tab.
 * It is never put in the URL, so it stays out of history, logs and referrers.
 */

const $ = (id) => document.getElementById(id);
let TOKEN = sessionStorage.getItem('haveniq_admin_token') || '';
let rows = [];
const picked = new Set();

const api = (path, opts = {}) => fetch(path, {
  ...opts,
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isFlagged = (r) => (r.risk_score ?? 0) >= 50;

async function unlock() {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) return;
  let r;
  try { r = await api('/bot-admin/pending-listings?limit=1'); }
  catch { $('gateerr').textContent = 'Network error.'; return; }
  if (!r.ok) {
    $('gateerr').textContent = (r.status === 401 || r.status === 403) ? 'Token rejected.' : 'Error ' + r.status;
    return;
  }
  sessionStorage.setItem('haveniq_admin_token', TOKEN);
  $('gate').hidden = true;
  $('app').hidden = false;
  load();
}

/** risk_signals is jsonb and its shape varies by rule, so render defensively. */
function signals(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x.label || x.rule || x.code || JSON.stringify(x)));
    return Object.keys(v);
  } catch { return []; }
}

async function load() {
  $('msg').textContent = 'Loading…';
  picked.clear();
  const src = $('src').value;
  const r = await api('/bot-admin/pending-listings?limit=200' + (src ? '&source=' + encodeURIComponent(src) : ''));
  if (!r.ok) { $('msg').textContent = 'Failed to load (' + r.status + ')'; return; }
  const data = await r.json();
  rows = data.listings || [];
  const p = data.pending || {};
  $('tally').innerHTML = `<b>${p.total ?? rows.length}</b> pending · <b>${p.flagged ?? 0}</b> flagged · showing ${rows.length}`;
  $('msg').textContent = '';
  render();
}

function render() {
  if (!rows.length) { $('out').innerHTML = '<div class="empty">Queue is clear.</div>'; sync(); return; }
  const flagged = rows.filter(isFlagged);
  const clean = rows.filter((r) => !isFlagged(r));
  $('out').innerHTML =
    (flagged.length ? `<div class="sechead">Flagged — ${flagged.length}, read these</div><div class="grid">${flagged.map(card).join('')}</div>` : '') +
    (clean.length ? `<div class="sechead">Clean — ${clean.length}</div><div class="grid">${clean.map(card).join('')}</div>` : '');
  sync();
}

function card(r) {
  const sig = signals(r.risk_signals);
  const flagged = isFlagged(r);
  const shot = r.photo_url
    ? `<img class="shot" src="${esc(r.photo_url)}" loading="lazy" alt="" data-pick="${r.id}">`
    : `<div class="nophoto" data-pick="${r.id}">no photo</div>`;
  return `
  <div class="card${flagged ? ' flagged' : ''}" id="c${r.id}">
    ${shot}
    <div class="body">
      <div class="addr">${esc(r.address || '(no address)')}</div>
      <div class="meta">${esc(r.city || '')}${r.city ? ' · ' : ''}${r.beds ?? '?'} bed · ${r.baths ?? '?'} bath</div>
      <div class="price">${money(r.perPerson)} <small>/person${r.total && r.total !== r.perPerson ? ' · ' + money(r.total) + ' total' : ''}</small></div>
      <div class="tags">
        <span class="tag src">${esc(r.source || 'manual')}</span>
        <span class="tag${flagged ? ' risk' : ''}">risk ${r.risk_score ?? '—'}</span>
        ${sig.slice(0, 3).map((s) => `<span class="tag risk">${esc(s)}</span>`).join('')}
      </div>
      <div class="notes">${esc((r.notes || '').slice(0, 180))}</div>
    </div>
    <div class="foot">
      <label><input type="checkbox" data-pick="${r.id}" id="k${r.id}"> select</label>
      ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">original ↗</a>` : ''}
    </div>
  </div>`;
}

function toggle(id) {
  picked.has(id) ? picked.delete(id) : picked.add(id);
  sync();
}

function selectClean() {
  // Never sweeps up a flagged listing — those are the ones worth a human's eye,
  // and a "select all" that quietly included them would defeat the point.
  picked.clear();
  rows.filter((r) => !isFlagged(r)).forEach((r) => picked.add(r.id));
  sync();
}

function sync() {
  rows.forEach((r) => {
    const on = picked.has(r.id);
    const box = $('k' + r.id); if (box) box.checked = on;
    const el = $('c' + r.id); if (el) el.classList.toggle('sel', on);
  });
  $('selcount').textContent = picked.size ? picked.size + ' selected' : '';
  $('okBtn').disabled = $('noBtn').disabled = picked.size === 0;
}

async function bulk(action) {
  const ids = [...picked];
  if (!ids.length) return;
  if (!confirm(`${action === 'approve' ? 'Approve' : 'Reject'} ${ids.length} listing(s)?`)) return;
  $('okBtn').disabled = $('noBtn').disabled = true;
  $('msg').textContent = 'Working…';
  // The endpoint caps a call at 200; chunk so a large selection still lands.
  let done = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const r = await api('/bot-admin/listings/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, ids: ids.slice(i, i + 200), reason: 'reviewed in queue' }),
    });
    if (!r.ok) { $('msg').textContent = 'Failed (' + r.status + ')'; return; }
    done += (await r.json()).acted || 0;
  }
  $('msg').textContent = `${action}d ${done} listing(s).`;
  load();
}

// ── Wiring ────────────────────────────────────────────────────────────────
$('unlock').addEventListener('click', unlock);
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
$('refresh').addEventListener('click', load);
$('src').addEventListener('change', load);
$('selClean').addEventListener('click', selectClean);
$('selNone').addEventListener('click', () => { picked.clear(); sync(); });
$('okBtn').addEventListener('click', () => bulk('approve'));
$('noBtn').addEventListener('click', () => bulk('reject'));

// Cards are rebuilt on every load, so listen on the container that outlives
// them rather than binding per card.
//
// Split across two events on purpose. The checkbox sits inside a <label>, and a
// label forwards its click to the input — so a single click on the label text
// arrives at a delegated CLICK handler twice, toggling on and straight back off
// again. `change` fires once no matter how the box was reached.
$('out').addEventListener('change', (e) => {
  const el = e.target.closest('input[data-pick]');
  if (el) toggle(Number(el.dataset.pick));
});

// The photo and the no-photo placeholder are not form controls, so they only
// ever produce a click.
$('out').addEventListener('click', (e) => {
  const el = e.target.closest('[data-pick]:not(input)');
  if (el) toggle(Number(el.dataset.pick));
});

if (TOKEN) { $('tok').value = TOKEN; unlock(); }

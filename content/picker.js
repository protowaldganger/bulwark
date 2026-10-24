// Element picker. Injected on demand (never preloaded).
// Mode "hover": point at an element and click it.
// Mode "target": start from the element under the last right click.
(() => {
  'use strict';
  const bw = window.__bw || (window.__bw = {});
  if (bw.pickerOpen) return;
  bw.pickerOpen = true;
  const mode = bw.pick || 'hover';

  // Random, meaningless tag name: nothing identifies the extension.
  const host = document.createElement('x-' + Math.random().toString(36).slice(2, 8));
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .hl { position: fixed; pointer-events: none; border: 2px solid #171717; background: rgba(23,23,23,.08);
        border-radius: 6px; box-shadow: 0 0 0 1px #fff; transition: all .08s linear; display: none; }
  .panel { position: fixed; right: 16px; bottom: 16px; width: min(400px, calc(100vw - 32px)); pointer-events: auto;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif; color: #171717;
        -webkit-font-smoothing: antialiased; background: #fff; border-radius: 18px; padding: 16px;
        box-shadow: 0 24px 60px rgba(0,0,0,.18), 0 0 0 1px rgba(23,23,23,.06); }
  .row { display: flex; gap: 8px; align-items: center; }
  .title { font-weight: 500; font-size: 15px; flex: 1; }
  .hint { color: rgba(23,23,23,.56); font-size: 13px; margin: 2px 0 12px; }
  textarea { width: 100%; min-height: 60px; resize: vertical; background: #f3f3f2; color: #171717; border: 1px solid transparent;
        border-radius: 12px; padding: 10px 12px; font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; outline: none; }
  textarea:focus { border-color: rgba(23,23,23,.38); }
  button { font: inherit; font-weight: 500; border: 0; border-radius: 999px; background: #ececec; color: #171717; height: 32px; padding: 0 14px; cursor: pointer; }
  button:hover { background: rgba(23,23,23,.14); }
  button.primary { background: #171717; color: #fff; }
  button.ghost { background: none; color: rgba(23,23,23,.56); padding: 0 8px; }
  .count { color: rgba(23,23,23,.38); font-size: 13px; margin-left: auto; }
  .actions { margin-top: 10px; }
  .spacer { flex: 1; }
</style>
<div class="hl"></div>
<div class="panel" role="dialog" aria-label="Block element">
  <div class="row"><div class="title">Block element</div><button class="ghost" data-a="close" aria-label="Close">Esc</button></div>
  <div class="hint">Click an element on the page, then adjust the selector if needed.</div>
  <textarea spellcheck="false" aria-label="CSS selector"></textarea>
  <div class="row actions">
    <button data-a="wider" title="Select the parent element">Wider</button>
    <button data-a="narrower" title="Back to the previous element">Narrower</button>
    <span class="count"></span>
  </div>
  <div class="row actions">
    <button data-a="pick">Pick again</button>
    <span class="spacer"></span>
    <button data-a="close">Cancel</button>
    <button class="primary" data-a="block">Block</button>
  </div>
</div>`;
  document.documentElement.appendChild(host);

  const hl = root.querySelector('.hl');
  const panel = root.querySelector('.panel');
  const ta = root.querySelector('textarea');
  const count = root.querySelector('.count');
  let picking = mode === 'hover';
  let current = null;
  const trail = [];

  const isOurs = (el) => el === host;

  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'); }
  function stableClass(c) { return c.length < 40 && !/\d{3,}|^[a-z]{1,2}\d|__[a-z0-9]{5,}$|^css-|^sc-|^jsx-/i.test(c); }

  function selectorFor(el) {
    if (el.id && /^[A-Za-z][\w-]{1,40}$/.test(el.id) && !/\d{4,}/.test(el.id)) return '#' + cssEscape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 4) {
      let part = node.localName;
      const classes = [...node.classList].filter(stableClass).slice(0, 2);
      if (classes.length) part += classes.map(c => '.' + cssEscape(c)).join('');
      const attr = ['data-ad', 'data-testid', 'aria-label', 'role'].find(a => node.hasAttribute(a) && node.getAttribute(a).length < 40);
      if (!classes.length && attr) part += `[${attr}="${node.getAttribute(attr).replace(/"/g, '\\"')}"]`;
      parts.unshift(part);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1 && (classes.length || attr)) return sel; } catch { /* keep walking */ }
      if (node.parentElement && node.parentElement.id && /^[A-Za-z][\w-]{1,40}$/.test(node.parentElement.id)) {
        parts.unshift('#' + cssEscape(node.parentElement.id));
        return parts.join(' > ');
      }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function show(el) {
    if (!el) { hl.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
  }

  function select(el) {
    current = el;
    ta.value = selectorFor(el);
    updateCount();
    show(el);
  }

  function updateCount() {
    let n = 0;
    try { n = document.querySelectorAll(ta.value).length; } catch { count.textContent = 'Invalid selector'; return; }
    count.textContent = n === 1 ? '1 element' : `${n} elements`;
  }

  function onMove(e) {
    if (!picking) return;
    host.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.display = '';
    if (el && !isOurs(el)) show(el);
  }
  function onClick(e) {
    if (!picking) return;
    const path = e.composedPath();
    if (path.includes(panel)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    host.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.display = '';
    if (!el || isOurs(el)) return;
    picking = false;
    trail.length = 0;
    select(el);
  }
  function close() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    bw.pickerOpen = false;
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  ta.addEventListener('input', () => {
    updateCount();
    try { const el = document.querySelector(ta.value); show(el); } catch { show(null); }
  });

  panel.addEventListener('click', async (e) => {
    const a = e.target.closest('button') && e.target.closest('button').dataset.a;
    if (!a) return;
    if (a === 'close') return close();
    if (a === 'pick') { picking = true; show(null); return; }
    if (a === 'wider' && current && current.parentElement && current.parentElement !== document.body) {
      trail.push(current); select(current.parentElement); return;
    }
    if (a === 'narrower' && trail.length) { select(trail.pop()); return; }
    if (a === 'block') {
      const sel = ta.value.trim();
      try { document.querySelector(sel); } catch { count.textContent = 'Invalid selector'; return; }
      if (!sel) return;
      const res = await chrome.runtime.sendMessage({ t: 'picker-add', selector: sel }).catch(() => null);
      if (res && res.ok) close(); else count.textContent = 'Could not save the filter';
    }
  });

  const target = mode === 'target' ? bw.ctx : null;
  if (target && target.nodeType === 1) { picking = false; select(target); }
})();

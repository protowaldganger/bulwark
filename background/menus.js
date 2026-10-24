// Context menu entries.

import { getSettings, hostOf, isWhitelisted, cookiePolicyFor } from './state.js';

export const MENU = {
  pick: 'bw-pick',
  blockUrl: 'bw-block-url',
  toggle: 'bw-toggle-site',
  cookies: 'bw-cookies',
  ckBlock: 'bw-ck-block',
  ckNecessary: 'bw-ck-necessary',
  ckAllow: 'bw-ck-allow',
  sep: 'bw-sep',
  options: 'bw-options'
};

const PAGE_CONTEXTS = ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio', 'editable'];

export async function createMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  const add = (o) => chrome.contextMenus.create(o, () => void chrome.runtime.lastError);
  add({ id: MENU.pick, title: 'Block element…', contexts: PAGE_CONTEXTS });
  add({ id: MENU.blockUrl, title: 'Block this media source', contexts: ['image', 'video', 'audio'] });
  add({ id: MENU.toggle, title: 'Pause blocking on this site', contexts: PAGE_CONTEXTS });
  add({ id: MENU.cookies, title: 'Cookies on this site', contexts: PAGE_CONTEXTS });
  add({ id: MENU.ckBlock, parentId: MENU.cookies, title: 'Block all', type: 'radio', contexts: PAGE_CONTEXTS });
  add({ id: MENU.ckNecessary, parentId: MENU.cookies, title: 'Necessary only', type: 'radio', contexts: PAGE_CONTEXTS, checked: true });
  add({ id: MENU.ckAllow, parentId: MENU.cookies, title: 'Allow all', type: 'radio', contexts: PAGE_CONTEXTS });
  add({ id: MENU.sep, type: 'separator', contexts: PAGE_CONTEXTS });
  add({ id: MENU.options, title: 'Open Bulwark dashboard', contexts: PAGE_CONTEXTS });
}

// Keeps titles and radio state in sync with the active tab.
export async function refreshMenus(url) {
  if (!chrome.contextMenus) return;
  const host = hostOf(url || '');
  const s = await getSettings();
  const upd = (id, props) => chrome.contextMenus.update(id, props, () => void chrome.runtime.lastError);
  const enabled = !!host;
  upd(MENU.toggle, { enabled, title: host && isWhitelisted(host, s) ? `Resume blocking on ${host}` : host ? `Pause blocking on ${host}` : 'Pause blocking on this site' });
  upd(MENU.cookies, { enabled, title: host ? `Cookies on ${host}` : 'Cookies on this site' });
  if (host) {
    const p = cookiePolicyFor(host, s);
    upd(MENU.ckBlock, { checked: p === 'block' });
    upd(MENU.ckNecessary, { checked: p === 'necessary' });
    upd(MENU.ckAllow, { checked: p === 'allow' });
  }
}

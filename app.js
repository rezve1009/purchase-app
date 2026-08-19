const state = {
  rows: [],
  searchTimers: new Map(),
  activeSearches: new Map(),
  toastTimer: null,
  authenticated: false,
  backendUrl: '',
  pin: '',
  shopifyConfigured: false,
  sheetConfigured: false,
  deferredInstallPrompt: null
};

const DRAFT_KEY = 'daily_purchase_github_v3_draft';
const HISTORY_KEY = 'daily_purchase_github_v3_history';
const BACKEND_KEY = 'daily_purchase_github_v3_backend';
const PIN_SESSION_KEY = 'daily_purchase_github_v3_pin';
const $ = (sel) => document.querySelector(sel);
const rowsContainer = $('#rowsContainer');
const emptyState = $('#emptyState');
const saveStatus = $('#saveStatus');
const lastSavedText = $('#lastSavedText');

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function newRow(copyParty = '') {
  return {
    id: uid(), date: todayISO(), partyName: copyParty, sku: '', qty: 1, rate: 0,
    compareRate: 0, remarks: '', productTitle: '', variantTitle: '', imageUrl: '',
    shopifyVariantId: '', isCustom: false, sheetRow: 0, sheetSentAt: '', sheetNeedsUpdate: false
  };
}
function money(n) { return new Intl.NumberFormat('en-BD', { maximumFractionDigits: 2 }).format(Number(n || 0)); }
function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function meaningful(row) {
  return Boolean(String(row.sku || '').trim() || String(row.partyName || '').trim() ||
    String(row.remarks || '').trim() || Number(row.rate) || Number(row.compareRate));
}
function calcTotal(row) { return Number(row.qty || 0) * Number(row.rate || 0); }
function cleanBackendUrl(value) {
  const v = String(value || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(v)) return '';
  return v.split('?')[0];
}

function saveDraftLocal() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), rows: state.rows }));
    setSaveStatus('Saved on device', 'ok');
    lastSavedText.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (_) { setSaveStatus('Save failed', 'bad'); }
}
function readDraftLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (parsed && Array.isArray(parsed.rows)) return parsed;
  } catch (_) {}
  return null;
}
function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}
function writeHistory(items) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100))); } catch (_) {}
}
function archiveCurrent() {
  const rows = state.rows.filter(meaningful).map(r => ({ ...r }));
  if (!rows.length) return null;
  const item = {
    id: uid(), createdAt: new Date().toISOString(), rows,
    rowCount: rows.length,
    totalQty: rows.reduce((s, r) => s + Number(r.qty || 0), 0),
    grandTotal: rows.reduce((s, r) => s + calcTotal(r), 0)
  };
  writeHistory([item, ...readHistory()]);
  return item;
}

function renderAll() {
  rowsContainer.innerHTML = '';
  state.rows.forEach(row => rowsContainer.appendChild(renderRow(row)));
  emptyState.classList.toggle('hidden', state.rows.length > 0);
  updateSummary();
}
function renderRow(row) {
  const wrapper = document.createElement('div');
  wrapper.className = 'purchase-row purchase-grid';
  wrapper.dataset.rowId = row.id;
  wrapper.innerHTML = `
    <div class="field field-date"><label class="field-label">Date</label><input class="input" type="date" data-field="date" value="${escapeHtml(row.date || todayISO())}" /></div>
    <div class="field field-party"><label class="field-label">Party Name</label><input class="input" type="text" data-field="partyName" value="${escapeHtml(row.partyName || '')}" placeholder="Party name" autocomplete="off" /></div>
    <div class="field field-sku"><label class="field-label">SKU</label><div class="sku-input-wrap">
      <input class="input sku-input" type="text" data-field="sku" value="${escapeHtml(row.sku || '')}" placeholder="Search Shopify SKU" autocomplete="off" />
      ${row.imageUrl ? `<button class="preview-btn" type="button" data-action="preview" title="View image"><img src="${escapeHtml(row.imageUrl)}" alt="" /></button>` : `<button class="preview-btn empty" type="button" data-action="preview" title="No image">▧</button>`}
    </div><div class="sku-results hidden"></div></div>
    <div class="field"><label class="field-label">Qnt</label><input class="input" type="number" min="0" step="1" data-field="qty" value="${Number(row.qty || 0)}" inputmode="numeric" /></div>
    <div class="field"><label class="field-label">Rate</label><input class="input" type="number" min="0" step="0.01" data-field="rate" value="${Number(row.rate || 0)}" inputmode="decimal" /></div>
    <div class="field"><label class="field-label">Total</label><div class="display-total" data-total>${money(calcTotal(row))}</div></div>
    <div class="field"><label class="field-label">Compare Rate</label><input class="input" type="number" min="0" step="0.01" data-field="compareRate" value="${Number(row.compareRate || 0)}" inputmode="decimal" /></div>
    <div class="field field-remarks"><label class="field-label">Remarks</label><textarea class="textarea" rows="1" data-field="remarks" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea></div>
    <div class="row-actions">
      <button class="send-sheet-btn${row.sheetRow && !row.sheetNeedsUpdate ? ' sent' : ''}" type="button" data-action="send-sheet">${row.sheetRow ? (row.sheetNeedsUpdate ? '↻ Update Sheet' : `✓ Sent #${Number(row.sheetRow)}`) : '⇧ Send to Sheet'}</button>
      <button class="icon-btn delete-row" type="button" data-action="delete">×</button>
    </div>`;
  return wrapper;
}
function updateSummary() {
  const dataRows = state.rows.filter(meaningful);
  $('#sumRows').textContent = dataRows.length;
  $('#sumQty').textContent = money(dataRows.reduce((sum, r) => sum + Number(r.qty || 0), 0));
  $('#sumTotal').textContent = `৳${money(dataRows.reduce((sum, r) => sum + calcTotal(r), 0))}`;
}
function getRow(rowId) { return state.rows.find(r => r.id === rowId); }
function setSaveStatus(text, mode = 'ok') {
  saveStatus.textContent = text;
  saveStatus.style.color = mode === 'ok' ? '#18864b' : mode === 'warn' ? '#a15c00' : '#b42318';
}
function scheduleSave() { saveDraftLocal(); }
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}
function setChip(chip, textEl, ok, label, warning = false) {
  chip.classList.remove('ok', 'bad', 'warn'); chip.classList.add(ok ? 'ok' : warning ? 'warn' : 'bad'); textEl.textContent = label;
}

function jsonp(action, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!state.backendUrl) return reject(new Error('Backend URL is not configured.'));
    const callback = `__purchase_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = new URL(state.backendUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('callback', callback);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const script = document.createElement('script');
    let timer;
    const cleanup = () => { clearTimeout(timer); delete window[callback]; script.remove(); };
    window[callback] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Could not reach Apps Script.')); };
    timer = setTimeout(() => { cleanup(); reject(new Error('Request timed out.')); }, timeoutMs);
    script.src = url.toString(); document.head.appendChild(script);
  });
}

async function checkBackend() {
  if (!state.backendUrl || !navigator.onLine) return null;
  try {
    const json = await jsonp('ping');
    state.shopifyConfigured = Boolean(json.shopifyConfigured);
    state.sheetConfigured = Boolean(json.sheetConfigured);
    setChip($('#shopifyChip'), $('#shopifyText'), state.shopifyConfigured, state.shopifyConfigured ? 'Shopify Connected' : 'Shopify Setup Needed');
    setChip($('#sheetChip'), $('#sheetText'), state.sheetConfigured, state.sheetConfigured ? 'Google Sheet Ready' : 'Sheet Setup Needed');
    setChip($('#cloudChip'), $('#cloudText'), true, 'Device Saved');
    return json;
  } catch (_) {
    setChip($('#shopifyChip'), $('#shopifyText'), false, 'Backend Offline');
    setChip($('#sheetChip'), $('#sheetText'), false, 'Backend Offline');
    setChip($('#cloudChip'), $('#cloudText'), true, 'Device Saved');
    return null;
  }
}

function closeAllSearches(except = null) {
  document.querySelectorAll('.sku-results').forEach(el => { if (el !== except) el.classList.add('hidden'); });
}
async function searchSku(rowEl, row, query) {
  const resultsBox = rowEl.querySelector('.sku-results');
  if (!query.trim()) return resultsBox.classList.add('hidden');
  closeAllSearches(resultsBox); resultsBox.classList.remove('hidden');
  resultsBox.innerHTML = '<div class="search-state">Searching Shopify…</div>';
  const searchId = uid(); state.activeSearches.set(row.id, searchId);
  try {
    if (!navigator.onLine) throw new Error('Offline');
    const json = await jsonp('search', { pin: state.pin, q: query.trim() });
    if (state.activeSearches.get(row.id) !== searchId) return;
    if (!json.ok) throw new Error(json.error || 'Shopify search error');
    const raw = Array.isArray(json.products) ? json.products : [];
    const needle = query.trim().toUpperCase().replace(/\s+/g, ' ');
    const results = raw.map(item => ({
      id: item.id || '', sku: item.sku || '', productTitle: item.title || '', variantTitle: item.variantTitle || '',
      price: item.price ?? '', imageUrl: item.image || '',
      isExactMatch: String(item.sku || '').trim().toUpperCase().replace(/\s+/g, ' ') === needle
    }));
    const options = results.map((item, index) => `
      <div class="sku-option${item.isExactMatch ? ' exact' : ''}" tabindex="0" data-result-index="${index}">
        ${item.imageUrl ? `<img class="sku-thumb" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />` : `<div class="sku-thumb sku-thumb-placeholder">▧</div>`}
        <div class="sku-option-copy"><div class="sku-option-title">${escapeHtml(item.productTitle || item.sku)}${item.isExactMatch ? '<span class="exact-badge">Exact</span>' : ''}</div>
        <div class="sku-option-meta">${escapeHtml(item.sku)}${item.variantTitle && item.variantTitle !== 'Default Title' ? ` • ${escapeHtml(item.variantTitle)}` : ''}</div></div>
        <div class="sku-price">${item.price !== '' ? `৳${escapeHtml(item.price)}` : ''}</div>
      </div>`).join('');
    resultsBox.innerHTML = `${options || '<div class="search-state">No Shopify SKU match found.</div>'}<div class="custom-option" data-custom-sku="${escapeHtml(query)}">Use custom SKU: <span>${escapeHtml(query)}</span></div>`;
    resultsBox._results = results;
  } catch (e) {
    resultsBox.innerHTML = `<div class="search-state">${escapeHtml(e.message || 'Could not reach Shopify.')}</div><div class="custom-option" data-custom-sku="${escapeHtml(query)}">Use custom SKU: <span>${escapeHtml(query)}</span></div>`;
  }
}
function applyShopifyResult(rowEl, row, item) {
  row.sku = item.sku || row.sku; row.productTitle = item.productTitle || ''; row.variantTitle = item.variantTitle || '';
  row.imageUrl = item.imageUrl || ''; row.shopifyVariantId = item.id || ''; row.isCustom = false;
  rowEl.querySelector('[data-field="sku"]').value = row.sku;
  const oldPreview = rowEl.querySelector('[data-action="preview"]');
  const replacement = document.createElement('button'); replacement.type = 'button'; replacement.dataset.action = 'preview';
  replacement.className = `preview-btn${row.imageUrl ? '' : ' empty'}`; replacement.innerHTML = row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="" />` : '▧';
  oldPreview.replaceWith(replacement); rowEl.querySelector('.sku-results').classList.add('hidden');
  markSheetDirty(rowEl, row); scheduleSave(); showToast(`Selected ${row.sku}`);
}
function refreshSheetButton(rowEl, row) {
  const btn = rowEl.querySelector('[data-action="send-sheet"]'); if (!btn) return;
  btn.classList.toggle('sent', Boolean(row.sheetRow && !row.sheetNeedsUpdate)); btn.disabled = false;
  btn.textContent = row.sheetRow ? (row.sheetNeedsUpdate ? '↻ Update Sheet' : `✓ Sent #${Number(row.sheetRow)}`) : '⇧ Send to Sheet';
}
function markSheetDirty(rowEl, row) { if (row.sheetRow) row.sheetNeedsUpdate = true; refreshSheetButton(rowEl, row); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function sendRowToSheet(rowEl, row) {
  if (!navigator.onLine) return showToast('Internet is required to send to Google Sheet.');
  if (!String(row.sku || '').trim()) return showToast('Enter or select an SKU first.');
  const btn = rowEl.querySelector('[data-action="send-sheet"]'); const oldText = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = row.sheetRow ? 'Updating…' : 'Sending…'; }
  try {
    // Write by POST (not JSONP). JSONP below is only used for read-only confirmation.
    const form = new URLSearchParams({
      action: 'sendToSheet', pin: state.pin, entryId: row.id,
      sheetRow: String(Number(row.sheetRow || 0)), date: row.date || '', partyName: row.partyName || '', sku: row.sku || '',
      qty: String(Number(row.qty || 0)), rate: String(Number(row.rate || 0)), remarks: row.remarks || ''
    });
    await fetch(state.backendUrl, { method: 'POST', mode: 'no-cors', body: form });

    let confirmedRow = 0;
    for (let attempt = 0; attempt < 6 && !confirmedRow; attempt++) {
      await wait(attempt === 0 ? 450 : 650);
      const check = await jsonp('checkSheetEntry', { pin: state.pin, entryId: row.id });
      if (check.ok && Number(check.row || 0) > 0) confirmedRow = Number(check.row);
    }
    if (!confirmedRow) throw new Error('Google Sheet did not confirm the row. Please try again.');

    row.sheetRow = confirmedRow; row.sheetSentAt = new Date().toISOString(); row.sheetNeedsUpdate = false;
    refreshSheetButton(rowEl, row); scheduleSave(); showToast(`Sent to Google Sheet row ${row.sheetRow}.`);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
    showToast(e.message || 'Could not send to Google Sheet.');
  }
}

rowsContainer.addEventListener('input', event => {
  const input = event.target.closest('[data-field]'); if (!input) return;
  const rowEl = event.target.closest('.purchase-row'); const row = rowEl ? getRow(rowEl.dataset.rowId) : null; if (!row) return;
  const field = input.dataset.field; let value = input.value; if (['qty', 'rate', 'compareRate'].includes(field)) value = Number(value || 0); row[field] = value;
  markSheetDirty(rowEl, row);
  if (field === 'qty' || field === 'rate') { rowEl.querySelector('[data-total]').textContent = money(calcTotal(row)); updateSummary(); }
  if (field === 'sku') {
    row.productTitle = ''; row.variantTitle = ''; row.imageUrl = ''; row.shopifyVariantId = ''; row.isCustom = true;
    const preview = rowEl.querySelector('[data-action="preview"]'); preview.className = 'preview-btn empty'; preview.innerHTML = '▧';
    clearTimeout(state.searchTimers.get(row.id)); const typed = String(value || '');
    state.searchTimers.set(row.id, setTimeout(() => searchSku(rowEl, row, typed), 320));
  }
  if (['partyName', 'remarks', 'date'].includes(field)) updateSummary(); scheduleSave();
});
rowsContainer.addEventListener('focusin', event => {
  if (!event.target.matches('.sku-input')) return; const rowEl = event.target.closest('.purchase-row'); const row = getRow(rowEl.dataset.rowId);
  if (row && event.target.value.trim()) searchSku(rowEl, row, event.target.value);
});
rowsContainer.addEventListener('click', event => {
  const rowEl = event.target.closest('.purchase-row'); if (!rowEl) return; const row = getRow(rowEl.dataset.rowId); if (!row) return;
  if (event.target.closest('[data-action="send-sheet"]')) return sendRowToSheet(rowEl, row);
  if (event.target.closest('[data-action="delete"]')) { state.rows = state.rows.filter(r => r.id !== row.id); renderAll(); scheduleSave(); return; }
  if (event.target.closest('[data-action="preview"]')) {
    if (!row.imageUrl) return showToast(row.sku ? 'This SKU has no Shopify image.' : 'Select a Shopify SKU first.');
    $('#imagePreview').src = row.imageUrl; $('#imageTitle').textContent = row.productTitle || row.variantTitle || 'Product';
    $('#imageSku').textContent = `SKU: ${row.sku}${row.variantTitle && row.variantTitle !== 'Default Title' ? ` • ${row.variantTitle}` : ''}`;
    $('#imageModal').classList.remove('hidden'); return;
  }
  const option = event.target.closest('[data-result-index]');
  if (option) { const box = option.closest('.sku-results'); const item = box?._results?.[Number(option.dataset.resultIndex)]; if (item) applyShopifyResult(rowEl, row, item); return; }
  const custom = event.target.closest('[data-custom-sku]');
  if (custom) {
    row.sku = custom.dataset.customSku || row.sku; row.isCustom = true; row.productTitle = ''; row.variantTitle = ''; row.imageUrl = ''; row.shopifyVariantId = '';
    rowEl.querySelector('[data-field="sku"]').value = row.sku; rowEl.querySelector('.sku-results').classList.add('hidden'); markSheetDirty(rowEl, row); scheduleSave(); showToast('Custom SKU kept');
  }
});
document.addEventListener('click', event => { if (!event.target.closest('.field-sku')) closeAllSearches(); });

function addRow() {
  const lastParty = state.rows.length ? state.rows[state.rows.length - 1].partyName : '';
  const row = newRow(lastParty || ''); state.rows.push(row); rowsContainer.appendChild(renderRow(row)); emptyState.classList.add('hidden'); updateSummary(); scheduleSave();
  setTimeout(() => rowsContainer.lastElementChild?.querySelector('.sku-input')?.focus(), 50);
}
$('#addRowBtn').addEventListener('click', addRow); $('#mobileAddBtn').addEventListener('click', addRow);

function copySafe(value) { return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }
async function copyForExcel() {
  const rows = state.rows.filter(meaningful); if (!rows.length) return showToast('Nothing to copy.');
  const lines = [['Date', 'Party Name', 'SKU', 'Qnt', 'Rate', 'Total', 'Compare Rate', 'Remarks'].join('\t'),
    ...rows.map(r => [copySafe(r.date), copySafe(r.partyName), copySafe(r.sku), Number(r.qty || 0), Number(r.rate || 0), calcTotal(r), Number(r.compareRate || 0), copySafe(r.remarks)].join('\t'))];
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); } catch (_) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showToast(`${rows.length} row${rows.length === 1 ? '' : 's'} copied — paste into Excel.`);
}
$('#copyBtn').addEventListener('click', copyForExcel); $('#mobileCopyBtn').addEventListener('click', copyForExcel);

function resetSheet() {
  const count = state.rows.filter(meaningful).length;
  const message = count ? `Current ${count} purchase row(s) will be saved in History, then a new blank sheet will open. Continue?` : 'Open a new blank sheet?';
  if (!confirm(message)) return; if (count) archiveCurrent(); state.rows = [newRow()]; renderAll(); scheduleSave(); showToast(count ? 'Saved to History. New sheet ready.' : 'New sheet ready.');
}
$('#resetBtn').addEventListener('click', resetSheet);

function openHistory() {
  $('#historyModal').classList.remove('hidden'); const list = $('#historyList'); const items = readHistory();
  if (!items.length) { list.innerHTML = '<div class="history-empty">No saved sheets yet. New Sheet will archive the current filled sheet here.</div>'; return; }
  list.innerHTML = items.map(item => `<div class="history-item"><div><div class="history-title">${escapeHtml(new Date(item.createdAt).toLocaleString())}</div><div class="history-meta">${item.rowCount} rows • Qty ${money(item.totalQty)} • Total ৳${money(item.grandTotal)}</div></div><button class="btn" type="button" data-restore-id="${escapeHtml(item.id)}">Restore</button></div>`).join('');
}
$('#historyBtn').addEventListener('click', openHistory); $('#mobileHistoryBtn').addEventListener('click', openHistory);
$('#historyList').addEventListener('click', event => {
  const btn = event.target.closest('[data-restore-id]'); if (!btn) return;
  if (!confirm('Restore this saved sheet? Your current filled sheet will be archived first.')) return;
  const items = readHistory(); const item = items.find(x => x.id === btn.dataset.restoreId); if (!item) return showToast('Saved sheet not found.');
  if (state.rows.some(meaningful)) archiveCurrent(); state.rows = item.rows.map(r => ({ ...newRow(), ...r, id: r.id || uid() })); if (!state.rows.length) state.rows = [newRow()];
  renderAll(); scheduleSave(); $('#historyModal').classList.add('hidden'); showToast('Saved sheet restored.');
});

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]'); if (!close) return;
  if (close.dataset.close === 'image') $('#imageModal').classList.add('hidden');
  if (close.dataset.close === 'history') $('#historyModal').classList.add('hidden');
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#imageModal').classList.add('hidden'); $('#historyModal').classList.add('hidden'); closeAllSearches(); } });

function showBackendSetup(message = '') {
  state.authenticated = false; $('#appRoot').classList.add('hidden'); $('#mobileActionbar').classList.add('hidden'); $('#loginScreen').classList.remove('hidden');
  $('#backendForm').classList.remove('hidden'); $('#loginForm').classList.add('hidden'); $('#backendError').textContent = message;
  $('#backendUrlInput').value = state.backendUrl || ''; setTimeout(() => $('#backendUrlInput').focus(), 50);
}
function showLogin(message = '') {
  state.authenticated = false; $('#appRoot').classList.add('hidden'); $('#mobileActionbar').classList.add('hidden'); $('#loginScreen').classList.remove('hidden');
  $('#backendForm').classList.add('hidden'); $('#loginForm').classList.remove('hidden'); $('#loginError').textContent = message; setTimeout(() => $('#pinInput').focus(), 50);
}
function showApp() {
  state.authenticated = true; $('#loginScreen').classList.add('hidden'); $('#appRoot').classList.remove('hidden'); $('#mobileActionbar').classList.remove('hidden');
}
$('#backendForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#backendError').textContent = '';
  const url = cleanBackendUrl($('#backendUrlInput').value); if (!url) { $('#backendError').textContent = 'Please paste the Apps Script /exec URL.'; return; }
  state.backendUrl = url;
  try {
    const json = await jsonp('ping'); if (!json.ok) throw new Error(json.error || 'Backend test failed');
    localStorage.setItem(BACKEND_KEY, url); state.shopifyConfigured = Boolean(json.shopifyConfigured); state.sheetConfigured = Boolean(json.sheetConfigured); showLogin();
  } catch (e) { $('#backendError').textContent = e.message || 'Could not connect to Apps Script.'; }
});
$('#changeConnectionLogin').addEventListener('click', () => showBackendSetup());
$('#connectionBtn').addEventListener('click', () => { if (confirm('Change the Apps Script backend URL?')) showBackendSetup(); });
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#loginError').textContent = ''; const pin = $('#pinInput').value.trim(); if (!pin) return;
  try {
    const json = await jsonp('auth', { pin }); if (!json.ok) { $('#loginError').textContent = json.error || 'Invalid PIN'; return; }
    state.pin = pin; sessionStorage.setItem(PIN_SESSION_KEY, pin); $('#pinInput').value = ''; showApp(); initData(); await checkBackend();
  } catch (e) { $('#loginError').textContent = e.message || 'Backend is not reachable.'; }
});
$('#logoutBtn').addEventListener('click', () => { state.pin = ''; sessionStorage.removeItem(PIN_SESSION_KEY); showLogin(); });

function initData() {
  const local = readDraftLocal(); state.rows = local?.rows?.length ? local.rows.map(r => ({ ...newRow(), ...r, id: r.id || uid() })) : [newRow()];
  renderAll(); setSaveStatus('Saved on device', 'ok'); if (local?.updatedAt) lastSavedText.textContent = `Saved ${new Date(local.updatedAt).toLocaleString()}`;
}
function updateNetworkStatus() {
  const online = navigator.onLine; setChip($('#networkChip'), $('#networkText'), online, online ? 'Online' : 'Offline', !online);
  setChip($('#cloudChip'), $('#cloudText'), true, 'Device Saved');
  if (online && state.authenticated) setTimeout(checkBackend, 300);
}
window.addEventListener('online', updateNetworkStatus); window.addEventListener('offline', updateNetworkStatus);

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.deferredInstallPrompt = event; $('#installBtn').classList.remove('hidden'); });
$('#installBtn').addEventListener('click', async () => {
  if (!state.deferredInstallPrompt) return showToast('Use browser menu → Add to Home screen / Install app.');
  state.deferredInstallPrompt.prompt(); await state.deferredInstallPrompt.userChoice; state.deferredInstallPrompt = null; $('#installBtn').classList.add('hidden');
});
window.addEventListener('appinstalled', () => { $('#installBtn').classList.add('hidden'); showToast('App installed on this device.'); });

async function boot() {
  updateNetworkStatus(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  state.backendUrl = cleanBackendUrl(localStorage.getItem(BACKEND_KEY) || '');
  state.pin = sessionStorage.getItem(PIN_SESSION_KEY) || '';
  if (!state.backendUrl) return showBackendSetup();
  if (state.pin) {
    try { const json = await jsonp('auth', { pin: state.pin }); if (json.ok) { showApp(); initData(); await checkBackend(); return; } } catch (_) {}
    state.pin = ''; sessionStorage.removeItem(PIN_SESSION_KEY);
  }
  showLogin();
}
boot();

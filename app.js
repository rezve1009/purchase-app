const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  backendUrl: '',
  pin: '',
  date: '',
  partyName: '',
  rows: [],
  pendingParties: [],
  parties: [],
  catalog: [],
  catalogMap: new Map(),
  catalogReady: false,
  catalogMeta: null,
  searchTimers: new Map(),
  searchCache: new Map(),
  deferredInstallPrompt: null,
  toastTimer: null,
  batchSentAt: '',
  batchNeedsUpdate: false,
  syncing: false,
  previewRowId: ''
};

const KEYS = {
  backend: 'daily_purchase_github_v3_backend',
  pinSession: 'daily_purchase_github_v3_pin',
  draft: 'daily_purchase_github_v4_draft',
  history: 'daily_purchase_github_v4_history',
  oldDraft: 'daily_purchase_github_v3_draft',
  oldHistory: 'daily_purchase_github_v3_history',
  catalogMeta: 'daily_purchase_v4_catalog_meta'
};

const DB_NAME = 'DailyPurchaseCatalogV4';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function money(n) {
  return new Intl.NumberFormat('en-BD', { maximumFractionDigits: 2 }).format(Number(n || 0));
}
function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function copySafe(value) { return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }
function calcTotal(row) { return Number(row.qty || 0) * Number(row.rate || 0); }
function meaningful(row) { return Boolean(String(row.sku || '').trim() || Number(row.rate || 0) || String(row.remarks || '').trim()); }
function wholeAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function activeMeaningfulRows() { return state.rows.filter(meaningful); }
function currentPartyGroup() {
  const rows = activeMeaningfulRows();
  const partyName = getPartyName();
  return rows.length ? { id: 'active', partyName, rows } : null;
}
function sessionGroups() {
  const groups = state.pendingParties.map(g => ({ ...g, rows: (g.rows || []).filter(meaningful) })).filter(g => g.rows.length);
  const active = currentPartyGroup();
  if (active) groups.push(active);
  return groups;
}
function sessionProductCount() { return sessionGroups().reduce((sum, g) => sum + g.rows.length, 0); }
function sessionTotals() {
  const groups = sessionGroups();
  return {
    qty: groups.reduce((s, g) => s + g.rows.reduce((q, r) => q + Number(r.qty || 0), 0), 0),
    total: groups.reduce((s, g) => s + g.rows.reduce((t, r) => t + calcTotal(r), 0), 0)
  };
}
function cleanBackendUrl(value) {
  const v = String(value || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(v)) return '';
  return v.split('?')[0];
}
function normalizeSku(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function compactSku(value) { return normalizeSku(value).replace(/[\s\-_/\\.]+/g, ''); }
function rowTemplate() {
  return {
    id: uid(), sku: '', qty: 1, rate: '', compareRate: '', remarks: '',
    productTitle: '', price: '', imageUrl: '', variantId: '', isCustom: false,
    compareLoading: false, sheetRow: 0
  };
}

function getPartyName() {
  return String($('#partyInput')?.value || '').trim();
}

function showToast(message, duration = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function setCatalogNotice(text = '') {
  const el = $('#catalogNotice');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function jsonp(action, params = {}, timeoutMs = 30000) {
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
    window[callback] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Could not reach Apps Script.')); };
    timer = setTimeout(() => { cleanup(); reject(new Error('Request timed out.')); }, timeoutMs);
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) db.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB could not open.'));
  });
}
async function idbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRODUCTS, 'readonly');
    const req = tx.objectStore(STORE_PRODUCTS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRODUCTS, 'readwrite');
    tx.objectStore(STORE_PRODUCTS).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPutMany(items) {
  if (!items.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRODUCTS, 'readwrite');
    const store = tx.objectStore(STORE_PRODUCTS);
    items.forEach(item => store.put(item));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function readCatalogLocalMeta() {
  try { return JSON.parse(localStorage.getItem(KEYS.catalogMeta) || 'null') || {}; }
  catch (_) { return {}; }
}
function writeCatalogLocalMeta(meta) {
  localStorage.setItem(KEYS.catalogMeta, JSON.stringify(meta || {}));
}
function rebuildCatalogIndexes(items) {
  state.catalog = (items || []).filter(x => x && x.id && x.sku);
  state.catalogMap = new Map(state.catalog.map(x => [x.id, x]));
  state.catalogReady = state.catalog.length > 0;
  state.searchCache.clear();
  $('#catalogCountText').textContent = state.catalog.length ? money(state.catalog.length) : '0';
}

function rankProduct(product, queryNorm, queryCompact) {
  const skuNorm = product.norm || normalizeSku(product.sku);
  const skuCompact = product.compact || compactSku(product.sku);
  if (skuNorm === queryNorm) return 0;
  if (skuCompact === queryCompact) return 1;
  if (skuNorm.startsWith(queryNorm)) return 2;
  if (skuCompact.startsWith(queryCompact)) return 3;
  if (skuNorm.includes(queryNorm)) return 4;
  if (skuCompact.includes(queryCompact)) return 5;
  const qTokens = queryNorm.split(' ').filter(Boolean);
  if (qTokens.length > 1 && qTokens.every(t => skuNorm.includes(t))) return 6;
  return 99;
}
function searchLocalCatalog(query) {
  const qNorm = normalizeSku(query);
  const qCompact = compactSku(query);
  if (!qNorm) return [];
  const cacheKey = `${qNorm}|${qCompact}`;
  if (state.searchCache.has(cacheKey)) return state.searchCache.get(cacheKey);
  const ranked = [];
  for (const product of state.catalog) {
    const rank = rankProduct(product, qNorm, qCompact);
    if (rank < 99) ranked.push({ product, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || String(a.product.sku).localeCompare(String(b.product.sku), undefined, { numeric: true, sensitivity: 'base' }));
  const result = ranked.slice(0, 30).map(x => x.product);
  state.searchCache.set(cacheKey, result);
  if (state.searchCache.size > 100) state.searchCache.delete(state.searchCache.keys().next().value);
  return result;
}

async function loadCatalogFromDevice() {
  try {
    const items = await idbGetAll();
    rebuildCatalogIndexes(items);
    if (items.length) setCatalogNotice('');
  } catch (err) {
    console.warn(err);
    setCatalogNotice('Local product index could not be opened. Search may be unavailable until refreshed.');
  }
}

async function fetchCatalogPages(action, params, pageSize = 700) {
  let offset = 0;
  const all = [];
  while (true) {
    const res = await jsonp(action, { pin: state.pin, ...params, offset, limit: pageSize }, 45000);
    if (!res.ok) throw new Error(res.error || 'Catalog download failed.');
    const items = Array.isArray(res.items) ? res.items : [];
    all.push(...items);
    offset += items.length;
    if (!res.hasMore || !items.length) break;
  }
  return all;
}

async function refreshLocalCatalog({ forceMeta = false } = {}) {
  if (!navigator.onLine || !state.pin) return;
  try {
    const serverMeta = await jsonp('catalogMeta', { pin: state.pin }, 30000);
    if (!serverMeta.ok) throw new Error(serverMeta.error || 'Could not read catalog status.');
    state.catalogMeta = serverMeta;
    updateSyncUi(serverMeta);

    if (serverMeta.syncing) {
      setCatalogNotice('Shopify catalog is being prepared. Existing local search is still available.');
      return;
    }
    if (!Number(serverMeta.count || 0)) {
      setCatalogNotice('Shopify catalog cache is empty. Run the first Full Sync from Apps Script, then reopen the app.');
      return;
    }

    const localMeta = readCatalogLocalMeta();
    const generationChanged = !localMeta.generation || localMeta.generation !== serverMeta.generation;
    const noLocal = !state.catalog.length;

    if (generationChanged || noLocal) {
      setSyncStatus('Downloading product catalog…');
      const items = await fetchCatalogPages('catalogPage', { generation: serverMeta.generation });
      await idbClear();
      await idbPutMany(items);
      rebuildCatalogIndexes(items);
      writeCatalogLocalMeta({ generation: serverMeta.generation, version: Number(serverMeta.version || 0), syncedAt: new Date().toISOString() });
      setCatalogNotice('');
      setSyncStatus('Products updated successfully');
      return;
    }

    if (Number(serverMeta.version || 0) > Number(localMeta.version || 0)) {
      setSyncStatus('Applying latest product updates…');
      const changes = await fetchCatalogPages('catalogDelta', { sinceVersion: Number(localMeta.version || 0) });
      await idbPutMany(changes);
      changes.forEach(item => state.catalogMap.set(item.id, item));
      rebuildCatalogIndexes([...state.catalogMap.values()]);
      writeCatalogLocalMeta({ generation: serverMeta.generation, version: Number(serverMeta.version || 0), syncedAt: new Date().toISOString() });
      setSyncStatus(`Updated ${changes.length} product${changes.length === 1 ? '' : 's'}`);
    } else if (forceMeta) {
      setSyncStatus('Products are up to date');
    }
  } catch (err) {
    console.warn(err);
    setSyncStatus(err.message || 'Catalog update failed');
    if (!state.catalog.length) setCatalogNotice('Product catalog is not available yet. Open the side menu and check sync setup.');
  }
}

function setSyncStatus(text) { $('#syncStatusText').textContent = text; }
function updateSyncUi(meta = {}) {
  const sync = meta.lastSync ? new Date(meta.lastSync) : null;
  $('#lastSyncText').textContent = sync && !Number.isNaN(sync.getTime()) ? sync.toLocaleString() : 'Never';
  $('#catalogCountText').textContent = money(Number(meta.count || state.catalog.length || 0));
  if (meta.syncing) setSyncStatus('Updating products…');
}

function saveDraft() {
  state.partyName = getPartyName();
  const draft = {
    updatedAt: new Date().toISOString(), date: state.date, partyName: state.partyName,
    rows: state.rows, pendingParties: state.pendingParties, batchSentAt: state.batchSentAt, batchNeedsUpdate: state.batchNeedsUpdate
  };
  try { localStorage.setItem(KEYS.draft, JSON.stringify(draft)); } catch (_) {}
}
function migrateOldDraft() {
  try {
    const old = JSON.parse(localStorage.getItem(KEYS.oldDraft) || 'null');
    if (!old || !Array.isArray(old.rows) || !old.rows.length) return null;
    const first = old.rows[0] || {};
    return {
      date: first.date || todayISO(), partyName: first.partyName || '', pendingParties: [], batchSentAt: '', batchNeedsUpdate: false,
      rows: old.rows.map(r => ({
        ...rowTemplate(), id: r.id || uid(), sku: r.sku || '', qty: Number(r.qty || 1), rate: r.rate === 0 ? '' : (r.rate ?? ''),
        compareRate: r.compareRate === 0 ? '' : (r.compareRate ?? ''), remarks: r.remarks || '', productTitle: r.productTitle || '',
        price: r.price || '', imageUrl: r.imageUrl || '', variantId: r.shopifyVariantId || '', isCustom: Boolean(r.isCustom), sheetRow: Number(r.sheetRow || 0)
      }))
    };
  } catch (_) { return null; }
}
function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(KEYS.draft) || 'null');
    if (d && Array.isArray(d.rows)) return d;
  } catch (_) {}
  return migrateOldDraft();
}
function readHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(KEYS.history) || '[]');
    if (Array.isArray(h)) return h;
  } catch (_) {}
  return [];
}
function writeHistory(items) {
  try { localStorage.setItem(KEYS.history, JSON.stringify(items.slice(0, 100))); } catch (_) {}
}
function currentBatchSnapshot() {
  const groups = sessionGroups().map(g => ({
    id: g.id || uid(),
    partyName: g.partyName || '',
    rows: g.rows.map(r => ({ ...r }))
  }));
  if (!groups.length) return null;
  const rows = groups.flatMap(g => g.rows.map(r => ({ ...r, partyName: g.partyName })));
  return {
    id: uid(), createdAt: new Date().toISOString(), date: state.date,
    partyName: groups.length === 1 ? groups[0].partyName : `${groups.length} Parties`,
    groups, rows,
    totalQty: rows.reduce((s, r) => s + Number(r.qty || 0), 0),
    totalAmount: rows.reduce((s, r) => s + calcTotal(r), 0)
  };
}
function archiveCurrent() {
  const snapshot = currentBatchSnapshot();
  if (!snapshot) return null;
  writeHistory([snapshot, ...readHistory()]);
  return snapshot;
}

function normalizeParty(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function uniquePartyList() {
  return [...new Set(state.parties.map(x => String(x || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function searchPartyList(query) {
  const q = normalizeParty(query);
  const list = uniquePartyList();
  if (!q) return list.slice(0, 25);
  return list
    .map(name => {
      const n = normalizeParty(name);
      let rank = 99;
      if (n === q) rank = 0;
      else if (n.startsWith(q)) rank = 1;
      else if (n.includes(q)) rank = 2;
      return { name, rank };
    })
    .filter(x => x.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 30)
    .map(x => x.name);
}

function renderPartySelect() {
  const input = $('#partyInput');
  if (!input) return;
  input.value = state.partyName || '';
  $('#partyResults')?.classList.add('hidden');
}

function renderPartyResults(query = '') {
  const box = $('#partyResults');
  if (!box) return;
  const results = searchPartyList(query);
  box._results = results;
  const q = String(query || '').trim();
  const html = results.map((name, index) => `
    <button class="party-result" type="button" data-party-index="${index}">
      <span class="party-result-icon">◦</span>
      <span>${escapeHtml(name)}</span>
    </button>`).join('');
  const newEntry = q
    ? `<button class="party-new-result" type="button" data-party-new="1">＋ New Party: ${escapeHtml(q)}</button>`
    : '<button class="party-new-result" type="button" data-party-new="1">＋ New Party</button>';
  box.innerHTML = `${html || '<div class="search-empty">No matching party found.</div>'}${newEntry}`;
  box.classList.remove('hidden');
}

function chooseParty(name) {
  const clean = String(name || '').trim();
  $('#partyInput').value = clean;
  state.partyName = clean;
  $('#partyResults').classList.add('hidden');
  markBatchDirty();
}

async function loadReferenceData() {
  if (!navigator.onLine) return;
  try {
    const res = await jsonp('referenceData', { pin: state.pin }, 30000);
    if (!res.ok) throw new Error(res.error || 'Could not load party list.');
    state.parties = Array.isArray(res.parties) ? res.parties : [];
    renderPartySelect();
  } catch (err) {
    console.warn(err);
    state.parties = [];
    renderPartySelect();
  }
}

function renderInlinePartyResults(box, query = '', groupId = '') {
  const results = searchPartyList(query);
  box._results = results;
  const q = String(query || '').trim();
  const html = results.map((name, index) => `
    <button class="party-result" type="button" data-saved-party-result="${index}" data-party-group-id="${escapeHtml(groupId)}">
      <span class="party-result-icon">◦</span>
      <span>${escapeHtml(name)}</span>
    </button>`).join('');
  const newEntry = q
    ? `<button class="party-new-result" type="button" data-saved-party-new="1" data-party-group-id="${escapeHtml(groupId)}">＋ New Party: ${escapeHtml(q)}</button>`
    : `<button class="party-new-result" type="button" data-saved-party-new="1" data-party-group-id="${escapeHtml(groupId)}">＋ New Party</button>`;
  box.innerHTML = `${html || '<div class="search-empty">No matching party found.</div>'}${newEntry}`;
  box.classList.remove('hidden');
}

function getPendingGroup(groupId) {
  return state.pendingParties.find(g => g.id === groupId) || null;
}

function renderPendingParties() {
  const container = $('#savedPartyCards');
  if (!container) return;
  const groups = state.pendingParties || [];
  if (!groups.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.innerHTML = '';
  groups.forEach((g, groupIndex) => {
    const groupCard = document.createElement('article');
    groupCard.className = 'party-group-card saved-party-group editable-saved-party';
    groupCard.dataset.groupId = g.id;
    groupCard.innerHTML = `
      <div class="party-group-head editable-party-head">
        <div class="party-head-main">
          <span class="party-group-kicker">PARTY ${groupIndex + 1}</span>
          <div class="field party-field inline-party-field">
            <label class="label">Party Name</label>
            <div class="party-combobox">
              <input class="input party-input saved-party-input" type="text" autocomplete="off" value="${escapeHtml(g.partyName || '')}" placeholder="Type to search party" data-party-group-id="${escapeHtml(g.id)}" />
              <div class="party-results saved-party-results hidden" data-party-results-for="${escapeHtml(g.id)}"></div>
            </div>
          </div>
        </div>
      </div>
      <section class="products-list saved-party-products"></section>
      <div class="party-card-footer-tools">
        <button class="text-button party-add-product" type="button" data-add-product-group="${escapeHtml(g.id)}">＋ Add Product</button>
      </div>
      <div class="party-card-total-row">
        <div><span>Total Qty</span><strong data-party-qty="${escapeHtml(g.id)}">0</strong></div>
        <div><span>Total Amount</span><strong data-party-amount="${escapeHtml(g.id)}">৳0</strong></div>
      </div>`;
    const products = groupCard.querySelector('.saved-party-products');
    (g.rows || []).forEach((row, index) => products.appendChild(renderProductCard(row, index, g.id)));
    container.appendChild(groupCard);
  });
  container.classList.remove('hidden');
  updatePendingGroupTotals();
}

function renderAll() {
  renderPendingParties();
  const container = $('#productsContainer');
  container.innerHTML = '';
  state.rows.forEach((row, index) => container.appendChild(renderProductCard(row, index, 'active')));
  $('#emptyState').classList.toggle('hidden', state.rows.length > 0);
  if ($('#activePartyKicker')) $('#activePartyKicker').textContent = `PARTY ${state.pendingParties.length + 1}`;
  updateSummary();
}

function renderProductCard(row, index, groupId = 'active') {
  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.rowId = row.id;
  card.dataset.groupId = groupId;
  const compareWhole = wholeAmount(row.compareRate);
  const compareText = row.compareLoading ? 'Loading…' : (compareWhole === null ? 'Nil' : `৳${money(compareWhole)}`);
  card.innerHTML = `
    <div class="product-card-head">
      <div class="product-number">PRODUCT ${index + 1}</div>
      <button class="remove-product" type="button" data-action="remove" aria-label="Remove product">×</button>
    </div>
    <div class="product-grid">
      <div class="field sku-field">
        <div class="sku-label-row"><label class="label">SKU Search</label><button class="new-entry-btn" type="button" data-action="new-entry">＋ New Entry</button></div>
        <div class="sku-control">
          <input class="input sku-input" data-field="sku" type="text" autocomplete="off" value="${escapeHtml(row.sku || '')}" placeholder="Type SKU" />
          <button class="product-thumb-button" type="button" data-action="preview" aria-label="Product preview">${row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="" />` : '▧'}</button>
        </div>
        <div class="sku-results hidden"></div>
      </div>
      <div class="field qty-field"><label class="label">Quantity</label><input class="input" data-field="qty" type="number" min="0" step="1" inputmode="numeric" value="${Number(row.qty || 0)}" /></div>
      <div class="field rate-field"><label class="label">Rate</label><input class="input" data-field="rate" type="number" min="0" step="0.01" inputmode="decimal" value="${row.rate === '' || row.rate === null || row.rate === undefined ? '' : Number(row.rate)}" placeholder="Rate" /></div>
      <div class="field compare-field">
        <label class="label">Compare Rate</label>
        <div class="compare-control">
          <div class="compare-box${row.compareLoading ? ' loading' : ''}" data-compare>${compareText}</div>
          <button class="compare-use-button" type="button" data-action="use-compare" aria-label="Use Compare Rate as Rate" title="Use Compare Rate as Rate">←</button>
        </div>
      </div>
      <div class="field remarks-field"><label class="label">Remarks</label><textarea class="textarea" data-field="remarks" rows="1" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea></div>
    </div>
    <div class="line-total"><span>Line Total</span><strong data-line-total>৳${money(calcTotal(row))}</strong></div>`;
  wireProductCard(card);
  return card;
}

function updatePendingGroupTotals() {
  (state.pendingParties || []).forEach(g => {
    const rows = (g.rows || []).filter(meaningful);
    const qty = rows.reduce((sum, r) => sum + Number(r.qty || 0), 0);
    const total = rows.reduce((sum, r) => sum + calcTotal(r), 0);
    const qtyEl = document.querySelector(`[data-party-qty="${CSS.escape(g.id)}"]`);
    const amountEl = document.querySelector(`[data-party-amount="${CSS.escape(g.id)}"]`);
    if (qtyEl) qtyEl.textContent = money(qty);
    if (amountEl) amountEl.textContent = `৳${money(total)}`;
  });
}

function updateSummary() {
  const rows = activeMeaningfulRows();
  const qty = rows.reduce((sum, r) => sum + Number(r.qty || 0), 0);
  const total = rows.reduce((sum, r) => sum + calcTotal(r), 0);
  const session = sessionTotals();
  if ($('#activePartyQty')) $('#activePartyQty').textContent = money(qty);
  if ($('#activePartyAmount')) $('#activePartyAmount').textContent = `৳${money(total)}`;
  if ($('#activePartyKicker')) $('#activePartyKicker').textContent = `PARTY ${state.pendingParties.length + 1}`;
  updatePendingGroupTotals();
  $('#grandTotalTop').textContent = `৳${money(session.total)}`;
  const send = $('#sendBatchBtn');
  if (state.batchSentAt && !state.batchNeedsUpdate) send.textContent = '✓ Sent to Sheet';
  else if (state.batchSentAt && state.batchNeedsUpdate) send.textContent = 'Update Sheet';
  else send.textContent = 'Send to Sheet';
}
function markBatchDirty() {
  if (state.batchSentAt) state.batchNeedsUpdate = true;
  saveDraft();
  updateSummary();
}
function getRow(id) {
  const active = state.rows.find(r => r.id === id);
  if (active) return active;
  for (const g of state.pendingParties || []) {
    const row = (g.rows || []).find(r => r.id === id);
    if (row) return row;
  }
  return null;
}
function getRowGroup(rowId) {
  if (state.rows.some(r => r.id === rowId)) return { id: 'active', rows: state.rows };
  return (state.pendingParties || []).find(g => (g.rows || []).some(r => r.id === rowId)) || null;
}

function renderSearchResults(card, row, query) {
  const box = card.querySelector('.sku-results');
  const results = searchLocalCatalog(query);
  box._results = results;
  const html = results.map((item, index) => `
    <button class="sku-result" type="button" data-result-index="${index}">
      ${item.imageUrl ? `<img class="sku-result-thumb" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />` : '<span class="sku-result-thumb sku-result-placeholder">▧</span>'}
      <span class="sku-result-sku">${escapeHtml(item.sku)}</span>
    </button>`).join('');
  box.innerHTML = `${html || '<div class="search-empty">No matching SKU found.</div>'}<div class="custom-search-action" data-action="custom-entry">＋ New Entry: ${escapeHtml(query)}</div>`;
  box.classList.remove('hidden');
}

function scheduleLocalSearch(card, row, query) {
  clearTimeout(state.searchTimers.get(row.id));
  state.searchTimers.set(row.id, setTimeout(async () => {
    const clean = String(query || '').trim();
    const box = card.querySelector('.sku-results');
    if (!clean) return box?.classList.add('hidden');
    closeSearches(box);

    // v4.7.1: recover the local index if catalog metadata is loaded but memory was not rebuilt.
    if (!state.catalogReady) {
      try {
        const items = await idbGetAll();
        if (items.length) rebuildCatalogIndexes(items);
      } catch (_) {}
    }

    if (!state.catalogReady) {
      if (box) {
        box.innerHTML = `<div class="search-empty">Product catalog is loading. Try again in a moment.</div><div class="custom-search-action" data-action="custom-entry">＋ New Entry: ${escapeHtml(clean)}</div>`;
        box.classList.remove('hidden');
      }
      // Attempt a background recovery without blocking typing.
      if (navigator.onLine && state.pin) refreshLocalCatalog({ forceMeta: true }).catch(() => {});
      return;
    }

    renderSearchResults(card, row, clean);
  }, 55));
}

async function loadCompareRate(row, card) {
  const sku = String(row.sku || '').trim();
  if (!sku || row.isCustom && !navigator.onLine) return;
  row.compareLoading = true;
  const box = card?.querySelector('[data-compare]');
  if (box) { box.textContent = 'Loading…'; box.classList.add('loading'); }
  try {
    if (!navigator.onLine) throw new Error('offline');
    const res = await jsonp('compareRate', { pin: state.pin, sku }, 25000);
    if (!res.ok) throw new Error(res.error || 'Compare rate lookup failed.');
    if (row.sku !== sku) return;
    row.compareRate = res.rate === null || res.rate === undefined || res.rate === '' ? '' : Math.trunc(Number(res.rate));
  } catch (_) {
    if (row.sku === sku) row.compareRate = '';
  } finally {
    row.compareLoading = false;
    const currentCard = document.querySelector(`[data-row-id="${row.id}"]`);
    const currentBox = currentCard?.querySelector('[data-compare]');
    if (currentBox) {
      currentBox.classList.remove('loading');
      const v = wholeAmount(row.compareRate);
      currentBox.textContent = v === null ? 'Nil' : `৳${money(v)}`;
    }
    saveDraft();
  }
}

function applyProduct(row, card, item) {
  row.sku = item.sku || '';
  row.productTitle = item.title || '';
  row.price = item.price ?? '';
  row.imageUrl = item.imageUrl || '';
  row.variantId = item.id || '';
  row.isCustom = false;
  const input = card.querySelector('[data-field="sku"]');
  input.value = row.sku;
  const thumb = card.querySelector('[data-action="preview"]');
  thumb.innerHTML = row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="" />` : '▧';
  card.querySelector('.sku-results').classList.add('hidden');
  markBatchDirty();
  loadCompareRate(row, card);
}
function applyCustomSku(row, card, sku) {
  row.sku = String(sku || '').trim();
  row.productTitle = '';
  row.price = '';
  row.imageUrl = '';
  row.variantId = '';
  row.isCustom = true;
  card.querySelector('[data-field="sku"]').value = row.sku;
  card.querySelector('[data-action="preview"]').innerHTML = '▧';
  card.querySelector('.sku-results').classList.add('hidden');
  markBatchDirty();
  loadCompareRate(row, card);
}

function wireProductCard(card) {
  if (!card || card.dataset.productEventsWired === '1') return;
  card.dataset.productEventsWired = '1';

  const currentRow = () => getRow(card.dataset.rowId);

  card.addEventListener('input', (event) => {
    const field = event.target.closest('[data-field]');
    if (!field) return;
    const row = currentRow();
    if (!row) return;
    const name = field.dataset.field;

    if (name === 'qty') row.qty = Number(field.value || 0);
    else if (name === 'rate') row.rate = field.value === '' ? '' : Number(field.value);
    else row[name] = field.value;

    if (name === 'sku') {
      row.productTitle = '';
      row.price = '';
      row.imageUrl = '';
      row.variantId = '';
      row.isCustom = true;
      row.compareRate = '';
      const thumb = card.querySelector('[data-action="preview"]');
      if (thumb) thumb.innerHTML = '▧';
      const compare = card.querySelector('[data-compare]');
      if (compare) compare.textContent = 'Nil';
      scheduleLocalSearch(card, row, field.value);
    }

    if (name === 'qty' || name === 'rate') {
      const line = card.querySelector('[data-line-total]');
      if (line) line.textContent = `৳${money(calcTotal(row))}`;
    }
    markBatchDirty();
  });

  card.addEventListener('focusin', (event) => {
    if (!event.target.matches('.sku-input')) return;
    const row = currentRow();
    if (row && event.target.value.trim()) scheduleLocalSearch(card, row, event.target.value);
  });

  card.addEventListener('keydown', (event) => {
    if (!event.target.matches('.sku-input') || event.key !== 'Enter') return;
    event.preventDefault();
    const box = card.querySelector('.sku-results');
    const first = box?.querySelector('[data-result-index="0"]');
    if (first) first.click();
    else card.querySelector('[data-action="custom-entry"]')?.click();
  });

  card.addEventListener('click', (event) => {
    const row = currentRow();
    if (!row) return;

    if (event.target.closest('[data-action="remove"]')) {
      event.preventDefault();
      event.stopPropagation();
      const group = getRowGroup(row.id);
      if (!group) return;
      group.rows = (group.rows || []).filter(r => r.id !== row.id);
      if (group.id === 'active' && !group.rows.length) group.rows.push(rowTemplate());
      renderAll();
      markBatchDirty();
      showToast('Product removed.');
      return;
    }

    if (event.target.closest('[data-action="use-compare"]')) {
      if (row.compareLoading) return showToast('Compare Rate is still loading.');
      if (row.compareRate === '' || row.compareRate === null || row.compareRate === undefined) return showToast('Compare Rate is Nil.');
      row.rate = Math.trunc(Number(row.compareRate || 0));
      const rateInput = card.querySelector('[data-field="rate"]');
      if (rateInput) rateInput.value = String(row.rate);
      const line = card.querySelector('[data-line-total]');
      if (line) line.textContent = `৳${money(calcTotal(row))}`;
      markBatchDirty();
      showToast('Compare Rate copied to Rate.');
      return;
    }

    const resultBtn = event.target.closest('[data-result-index]');
    if (resultBtn) {
      const box = resultBtn.closest('.sku-results');
      const item = box?._results?.[Number(resultBtn.dataset.resultIndex)];
      if (item) applyProduct(row, card, item);
      return;
    }

    if (event.target.closest('[data-action="custom-entry"]')) {
      applyCustomSku(row, card, card.querySelector('[data-field="sku"]')?.value || '');
      return;
    }

    if (event.target.closest('[data-action="new-entry"]')) {
      const input = card.querySelector('[data-field="sku"]');
      input?.focus();
      if (input?.value.trim()) applyCustomSku(row, card, input.value);
      else showToast('Type the new SKU here, then press Enter.');
      return;
    }

    if (event.target.closest('[data-action="preview"]')) {
      if (!row.imageUrl) return showToast(row.sku ? 'No Shopify image for this SKU.' : 'Select a Shopify product first.');
      state.previewRowId = row.id;
      $('#previewImage').src = row.imageUrl;
      $('#previewSku').textContent = `SKU: ${row.sku}`;
      $('#previewTitle').textContent = row.productTitle || 'Product';
      const priceToggle = $('#previewPriceToggle');
      const hasPrice = !(row.price === '' || row.price === null || row.price === undefined);
      priceToggle.dataset.price = hasPrice ? String(row.price) : '';
      priceToggle.dataset.revealed = 'false';
      priceToggle.setAttribute('aria-pressed', 'false');
      priceToggle.setAttribute('aria-label', hasPrice ? 'Show sale price' : 'Sale price unavailable');
      $('#previewPriceValue').textContent = hasPrice ? '••••••' : 'Not available';
      $('#previewPriceEye').textContent = '👁';
      $('#imageModal').classList.remove('hidden');
    }
  });
}

$('#previewPriceToggle').addEventListener('click', () => {
  const btn = $('#previewPriceToggle');
  const raw = btn.dataset.price || '';
  if (!raw) return showToast('Sale price is not available for this product.');
  const revealed = btn.dataset.revealed === 'true';
  const next = !revealed;
  btn.dataset.revealed = String(next);
  btn.setAttribute('aria-pressed', String(next));
  btn.setAttribute('aria-label', next ? 'Hide sale price' : 'Show sale price');
  $('#previewPriceValue').textContent = next ? `৳${money(raw)}` : '••••••';
  $('#previewPriceEye').textContent = next ? '◉' : '👁';
});


async function imageElementFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not prepare product image.')); };
    img.src = url;
  });
}

async function buildProductPhotoCard(row) {
  if (!row?.imageUrl) throw new Error('Product image is not available.');
  const response = await fetch(row.imageUrl, { mode: 'cors', cache: 'force-cache' });
  if (!response.ok) throw new Error('Could not load product image.');
  const image = await imageElementFromBlob(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const area = { x: 54, y: 54, w: 972, h: 1110 };
  const scale = Math.min(area.w / image.naturalWidth, area.h / image.naturalHeight);
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  const dx = area.x + (area.w - dw) / 2;
  const dy = area.y + (area.h - dh) / 2;
  ctx.drawImage(image, dx, dy, dw, dh);

  ctx.strokeStyle = '#eeeeee';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(54, 1192);
  ctx.lineTo(1026, 1192);
  ctx.stroke();

  const sku = String(row.sku || '').trim();
  ctx.fillStyle = '#111214';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 54px Arial, sans-serif';
  const maxWidth = 900;
  let fontSize = 54;
  while (ctx.measureText(sku).width > maxWidth && fontSize > 30) {
    fontSize -= 2;
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  }
  ctx.fillText(sku, 540, 1268, maxWidth);

  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create photo card.')), 'image/jpeg', 0.94));
}

function safeFileName(value) {
  return String(value || 'product').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'product';
}

async function savePreviewPhotoCard() {
  const row = getRow(state.previewRowId);
  if (!row) return showToast('Open a product preview first.');
  const btn = $('#savePhotoCardBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const blob = await buildProductPhotoCard(row);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${safeFileName(row.sku)}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Photo card saved.');
  } catch (err) { showToast(err.message || 'Could not save photo card.', 3500); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function sharePreviewPhotoCard() {
  const row = getRow(state.previewRowId);
  if (!row) return showToast('Open a product preview first.');
  const btn = $('#sharePhotoCardBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const blob = await buildProductPhotoCard(row);
    const file = new File([blob], `${safeFileName(row.sku)}.jpg`, { type: 'image/jpeg' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ files: [file], title: row.sku || 'Product' });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('Sharing is not supported here. Card saved instead.');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') showToast(err.message || 'Could not share photo card.', 3500);
  } finally { btn.disabled = false; btn.textContent = old; }
}

$('#savePhotoCardBtn').addEventListener('click', savePreviewPhotoCard);
$('#sharePhotoCardBtn').addEventListener('click', sharePreviewPhotoCard);

document.addEventListener('click', (event) => {
  if (!event.target.closest('.sku-field')) closeSearches();
  if (!event.target.closest('.party-field')) $$('.party-results').forEach(el => el.classList.add('hidden'));
  const close = event.target.closest('[data-close-modal]');
  if (close) $('#'+(close.dataset.closeModal === 'image' ? 'imageModal' : 'historyModal')).classList.add('hidden');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeSearches();
  $('#imageModal').classList.add('hidden');
  $('#historyModal').classList.add('hidden');
  closeDrawer();
});

function addProduct(focus = true) {
  const row = rowTemplate();
  state.rows.push(row);
  const card = renderProductCard(row, state.rows.length - 1);
  $('#productsContainer').appendChild(card);
  $('#emptyState').classList.add('hidden');
  updateSummary(); markBatchDirty();
  if (focus) setTimeout(() => card.querySelector('.sku-input')?.focus(), 40);
}
$('#addAnotherBtn').addEventListener('click', () => addProduct());

function moveToNextParty() {
  if (state.batchSentAt && !state.batchNeedsUpdate) return showToast('This purchase is already sent. Use New Purchase.');
  const party = getPartyName();
  const rows = activeMeaningfulRows();
  if (!party) return showToast('Select or enter the current Party Name first.');
  if (!rows.length) return showToast('Add at least one product before moving to Next Party.');
  if (rows.some(r => !String(r.sku || '').trim())) return showToast('Every product needs an SKU.');
  state.pendingParties.push({ id: uid(), partyName: party, rows: rows.map(r => ({ ...r })) });
  state.partyName = '';
  state.rows = [rowTemplate()];
  $('#partyInput').value = '';
  state.batchNeedsUpdate = Boolean(state.batchSentAt);
  renderPartySelect();
  renderAll();
  saveDraft();
  setTimeout(() => {
    $('#activePartyCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#partyInput')?.focus(), 180);
  }, 40);
  showToast('Next Party ready below. Previous parties remain editable.');
}
$('#nextPartyBtn').addEventListener('click', moveToNextParty);

$('#purchaseDate').addEventListener('change', () => { state.date = $('#purchaseDate').value || todayISO(); markBatchDirty(); });

$('#partyInput').addEventListener('input', () => {
  state.partyName = getPartyName();
  renderPartyResults(state.partyName);
  markBatchDirty();
});
$('#partyInput').addEventListener('focus', () => renderPartyResults(getPartyName()));
$('#partyInput').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('#partyResults').classList.add('hidden');
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const box = $('#partyResults');
  const first = box.querySelector('[data-party-index="0"]');
  if (first) first.click();
  else if (getPartyName()) chooseParty(getPartyName());
});
$('#partyResults').addEventListener('click', (event) => {
  const result = event.target.closest('[data-party-index]');
  if (result) {
    const name = $('#partyResults')._results?.[Number(result.dataset.partyIndex)];
    if (name) chooseParty(name);
    return;
  }
  if (event.target.closest('[data-party-new]')) {
    const current = getPartyName();
    if (!current) {
      $('#partyResults').classList.add('hidden');
      $('#partyInput').focus();
      showToast('Type the new Party Name.');
      return;
    }
    chooseParty(current);
    showToast('New Party selected.');
  }
});


$('#savedPartyCards').addEventListener('input', (event) => {
  const input = event.target.closest('.saved-party-input');
  if (!input) return;
  const group = getPendingGroup(input.dataset.partyGroupId);
  if (!group) return;
  group.partyName = String(input.value || '').trim();
  const box = input.closest('.party-combobox')?.querySelector('.saved-party-results');
  if (box) renderInlinePartyResults(box, input.value, group.id);
  markBatchDirty();
});

$('#savedPartyCards').addEventListener('focusin', (event) => {
  const input = event.target.closest('.saved-party-input');
  if (!input) return;
  const box = input.closest('.party-combobox')?.querySelector('.saved-party-results');
  if (box) renderInlinePartyResults(box, input.value, input.dataset.partyGroupId);
});

$('#savedPartyCards').addEventListener('keydown', (event) => {
  const input = event.target.closest('.saved-party-input');
  if (!input) return;
  const box = input.closest('.party-combobox')?.querySelector('.saved-party-results');
  if (event.key === 'Escape') {
    box?.classList.add('hidden');
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const first = box?.querySelector('[data-saved-party-result="0"]');
  if (first) first.click();
  else {
    const group = getPendingGroup(input.dataset.partyGroupId);
    if (group) {
      group.partyName = String(input.value || '').trim();
      box?.classList.add('hidden');
      markBatchDirty();
    }
  }
});

$('#savedPartyCards').addEventListener('click', (event) => {
  const result = event.target.closest('[data-saved-party-result]');
  if (result) {
    const group = getPendingGroup(result.dataset.partyGroupId);
    const box = result.closest('.saved-party-results');
    const name = box?._results?.[Number(result.dataset.savedPartyResult)];
    if (group && name) {
      group.partyName = name;
      const input = document.querySelector(`.saved-party-input[data-party-group-id="${CSS.escape(group.id)}"]`);
      if (input) input.value = name;
      box.classList.add('hidden');
      markBatchDirty();
    }
    return;
  }

  const newParty = event.target.closest('[data-saved-party-new]');
  if (newParty) {
    const group = getPendingGroup(newParty.dataset.partyGroupId);
    const input = document.querySelector(`.saved-party-input[data-party-group-id="${CSS.escape(newParty.dataset.partyGroupId)}"]`);
    if (!group || !input) return;
    const typed = String(input.value || '').trim();
    if (!typed) return showToast('Type the Party Name first.');
    group.partyName = typed;
    newParty.closest('.saved-party-results')?.classList.add('hidden');
    markBatchDirty();
    return;
  }

  const addBtn = event.target.closest('[data-add-product-group]');
  if (addBtn) {
    const group = getPendingGroup(addBtn.dataset.addProductGroup);
    if (!group) return;
    const row = rowTemplate();
    group.rows.push(row);
    renderAll();
    markBatchDirty();
    setTimeout(() => document.querySelector(`[data-row-id="${CSS.escape(row.id)}"] .sku-input`)?.focus(), 40);
  }
});

function submitBatchDirect(formParams, requestId, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const frameName = `purchase_sheet_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = state.backendUrl;
    form.target = frameName;
    form.style.display = 'none';

    const payload = { ...formParams, responseMode: 'message' };
    Object.entries(payload).forEach(([key, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = String(value ?? '');
      form.appendChild(input);
    });

    let finished = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      setTimeout(() => { form.remove(); iframe.remove(); }, 50);
    };
    const finishResolve = (value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };
    const onMessage = (event) => {
      const msg = event.data;
      if (!msg || msg.source !== 'daily-purchase-sheet' || msg.requestId !== requestId) return;
      finishResolve(msg.payload || {});
    };

    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);
    document.body.appendChild(form);

    timer = setTimeout(async () => {
      if (finished) return;
      try {
        const status = await jsonp('batchStatus', { pin: state.pin, requestId }, 10000);
        if (status?.done) finishResolve(status);
        else finishReject(new Error('Google Sheet response is taking too long. Please try once more.'));
      } catch (err) {
        finishReject(err);
      }
    }, timeoutMs);

    form.submit();
  });
}

async function sendBatchToSheet() {
  const groups = sessionGroups();
  if (!groups.length) return showToast('Add at least one product.');
  if (groups.some(g => !String(g.partyName || '').trim())) return showToast('Every party needs a Party Name.');

  const rows = groups.flatMap(g => g.rows.map(r => ({ ...r, partyName: g.partyName })));
  if (rows.some(r => !String(r.sku || '').trim())) return showToast('Every product needs an SKU.');
  if (!navigator.onLine) return showToast('Internet is required to send to Google Sheet.');

  const btn = $('#sendBatchBtn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = state.batchSentAt ? 'Updating…' : 'Sending…';

  try {
    const requestId = uid();
    const payloadRows = rows.map(r => ({
      entryId: r.id,
      sheetRow: Number(r.sheetRow || 0),
      partyName: r.partyName,
      sku: r.sku,
      qty: Number(r.qty || 0),
      rate: Number(r.rate || 0),
      remarks: r.remarks || ''
    }));

    const form = new URLSearchParams({
      action: 'sendBatchToSheet',
      requestId,
      pin: state.pin,
      date: state.date || todayISO(),
      partyName: '',
      isUpdate: state.batchSentAt ? '1' : '0',
      itemsJson: JSON.stringify(payloadRows)
    });

    // Reliable Apps Script flow used in the earlier stable builds:
    // POST once, then poll a tiny acknowledgement from Script Cache.
    fetch(state.backendUrl, { method: 'POST', mode: 'no-cors', body: form }).catch(() => {});

    let ack = null;
    const waits = [300, 350, 450, 600, 800, 1050, 1400, 1800];
    for (const wait of waits) {
      await new Promise(resolve => setTimeout(resolve, wait));
      const status = await jsonp('batchStatus', { pin: state.pin, requestId }, 12000);
      if (status?.done) {
        ack = status;
        break;
      }
    }

    if (!ack) throw new Error('Google Sheet response is taking too long. Please try once more.');
    if (!ack.ok) throw new Error(ack.error || 'Could not send products to Google Sheet.');
    if (Number(ack.count || 0) !== rows.length) throw new Error('Google Sheet did not save all products. Please try again.');

    const rowMap = ack.rows || {};
    state.pendingParties.forEach(g => (g.rows || []).forEach(r => {
      r.sheetRow = Number(rowMap[r.id] || r.sheetRow || 0);
    }));
    state.rows.forEach(r => {
      r.sheetRow = Number(rowMap[r.id] || r.sheetRow || 0);
    });

    state.batchSentAt = new Date().toISOString();
    state.batchNeedsUpdate = false;
    saveDraft();
    updateSummary();
    showToast(`${rows.length} product${rows.length === 1 ? '' : 's'} from ${groups.length} part${groups.length === 1 ? 'y' : 'ies'} sent to Google Sheet.`);
  } catch (err) {
    showToast(err.message || 'Could not send to Google Sheet.', 4200);
  } finally {
    btn.disabled = false;
    if (!state.batchSentAt) btn.textContent = oldText;
    updateSummary();
  }
}

$('#sendBatchBtn').addEventListener('click', sendBatchToSheet);

async function copyForExcel() {
  const groups = sessionGroups();
  const rows = groups.flatMap(g => g.rows.map(r => ({ ...r, partyName: g.partyName })));
  if (!rows.length) return showToast('Nothing to copy.');
  const lines = [
    ['Date','Party Name','SKU','Qnt','Rate','Total','Compare Rate','Remarks'].join('\t'),
    ...rows.map(r => [copySafe(state.date), copySafe(r.partyName), copySafe(r.sku), Number(r.qty || 0), Number(r.rate || 0), calcTotal(r), wholeAmount(r.compareRate) ?? '', copySafe(r.remarks)].join('\t'))
  ];
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showToast(`${rows.length} row${rows.length === 1 ? '' : 's'} copied for Excel.`);
}
$('#copyBtn').addEventListener('click', () => { copyForExcel(); closeDrawer(); });

function resetCurrent({ archive = true } = {}) {
  if (archive && sessionProductCount()) archiveCurrent();
  state.date = todayISO(); state.partyName = ''; state.rows = [rowTemplate()]; state.pendingParties = []; state.batchSentAt = ''; state.batchNeedsUpdate = false;
  $('#purchaseDate').value = state.date; renderPartySelect(); renderAll(); saveDraft();
}
$('#newPurchaseTopBtn').addEventListener('click', () => {
  const count = sessionProductCount();
  if (!count) {
    resetCurrent({ archive: false });
    return showToast('New purchase ready.');
  }

  const safelySent = Boolean(state.batchSentAt && !state.batchNeedsUpdate);
  if (!safelySent && !confirm('Start a new purchase? Current entries will be saved in History.')) return;

  resetCurrent({ archive: true });
  showToast(safelySent ? 'Purchase saved. New purchase ready.' : 'Current purchase saved in History.');
});

function openHistory() {
  const list = $('#historyList');
  const items = readHistory();
  if (!items.length) list.innerHTML = '<div class="search-empty">No history saved yet.</div>';
  else list.innerHTML = items.map(item => `
    <div class="history-item">
      <div><div class="history-item-title">${escapeHtml(item.partyName || 'No Party')}</div><div class="history-item-meta">${escapeHtml(item.date || '')} • ${item.rows?.length || 0} products${item.groups?.length > 1 ? ` • ${item.groups.length} parties` : ''} • Qty ${money(item.totalQty)} • ৳${money(item.totalAmount)}</div></div>
      <button class="btn" type="button" data-restore-history="${escapeHtml(item.id)}">Restore</button>
    </div>`).join('');
  $('#historyModal').classList.remove('hidden'); closeDrawer();
}
$('#historyBtn').addEventListener('click', openHistory);
$('#historyList').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-restore-history]');
  if (!btn) return;
  const item = readHistory().find(x => x.id === btn.dataset.restoreHistory);
  if (!item) return showToast('History item not found.');
  if (sessionProductCount() && !confirm('Restore this history? Current purchase session will be archived first.')) return;
  if (sessionProductCount()) archiveCurrent();
  state.date = item.date || todayISO();
  if (Array.isArray(item.groups) && item.groups.length) {
    const restored = item.groups.map(g => ({ id: g.id || uid(), partyName: g.partyName || '', rows: (g.rows || []).map(r => ({ ...rowTemplate(), ...r, id: r.id || uid() })) }));
    const active = restored.pop();
    state.pendingParties = restored;
    state.partyName = active?.partyName || '';
    state.rows = active?.rows?.length ? active.rows : [rowTemplate()];
  } else {
    state.pendingParties = [];
    state.partyName = item.partyName || '';
    state.rows = (item.rows || []).map(r => ({ ...rowTemplate(), ...r, id: r.id || uid() }));
    if (!state.rows.length) state.rows = [rowTemplate()];
  }
  state.batchSentAt = ''; state.batchNeedsUpdate = false;
  $('#purchaseDate').value = state.date; renderPartySelect(); renderAll(); saveDraft();
  $('#historyModal').classList.add('hidden'); showToast('History restored.');
});
$('#clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('Are you sure you want to clear all history?')) return;
  writeHistory([]); closeDrawer(); showToast('History cleared.');
});

function openDrawer() { $('#sideDrawer').classList.add('open'); $('#sideDrawer').setAttribute('aria-hidden','false'); $('#drawerBackdrop').classList.remove('hidden'); }
function closeDrawer() { $('#sideDrawer').classList.remove('open'); $('#sideDrawer').setAttribute('aria-hidden','true'); $('#drawerBackdrop').classList.add('hidden'); }
$('#menuBtn').addEventListener('click', openDrawer);
$('#closeDrawerBtn').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

async function manualSync(full = false) {
  if (state.syncing) return;
  if (!navigator.onLine) return showToast('Internet is required to sync Shopify.');
  const button = full ? $('#fullSyncBtn') : $('#manualSyncBtn');
  if (full && !confirm('Full catalog rebuild downloads the complete Shopify SKU catalog. Continue?')) return;
  state.syncing = true; button.disabled = true; setSyncStatus('Updating products…');
  try {
    const action = full ? 'startFullSync' : 'syncIncremental';
    const res = await jsonp(action, { pin: state.pin }, full ? 90000 : 60000);
    if (!res.ok) throw new Error(res.error || 'Sync failed.');
    if (res.continuing) {
      setSyncStatus('Full sync started. It will continue automatically…');
      showToast('Full sync started. You can keep using the app.');
    } else {
      setSyncStatus('Products updated successfully');
      showToast(`Products updated${res.changed !== undefined ? ` • ${res.changed} changed` : ''}.`);
    }
    await refreshLocalCatalog({ forceMeta: true });
  } catch (err) {
    setSyncStatus(err.message || 'Sync failed'); showToast(err.message || 'Sync failed.', 3600);
  } finally {
    state.syncing = false; button.disabled = false;
  }
}
$('#manualSyncBtn').addEventListener('click', () => manualSync(false));
$('#fullSyncBtn').addEventListener('click', () => manualSync(true));

function showBackendSetup() {
  $('#loginScreen').classList.remove('hidden'); $('#appRoot').classList.add('hidden');
  $('#backendForm').classList.remove('hidden'); $('#loginForm').classList.add('hidden');
  $('#loginIntro').textContent = 'Paste your Apps Script Web App URL once.';
  $('#backendUrlInput').value = state.backendUrl || '';
}
function showLogin() {
  $('#loginScreen').classList.remove('hidden'); $('#appRoot').classList.add('hidden');
  $('#backendForm').classList.add('hidden'); $('#loginForm').classList.remove('hidden');
  $('#loginIntro').textContent = 'Enter your private PIN.';
  setTimeout(() => $('#pinInput').focus(), 30);
}
function showApp() { $('#loginScreen').classList.add('hidden'); $('#appRoot').classList.remove('hidden'); }

$('#backendForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = cleanBackendUrl($('#backendUrlInput').value);
  if (!url) { $('#backendError').textContent = 'Enter a valid Apps Script /exec URL.'; return; }
  state.backendUrl = url; localStorage.setItem(KEYS.backend, url); $('#backendError').textContent = '';
  try {
    const res = await jsonp('ping', {}, 20000);
    if (!res.ok) throw new Error('Backend did not respond.');
    showLogin();
  } catch (err) { $('#backendError').textContent = err.message || 'Could not connect.'; }
});
$('#changeConnectionLogin').addEventListener('click', showBackendSetup);
$('#connectionBtn').addEventListener('click', () => { closeDrawer(); showBackendSetup(); });

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('#pinInput').value.trim();
  if (!pin) return;
  $('#loginError').textContent = '';
  try {
    const res = await jsonp('auth', { pin }, 20000);
    if (!res.ok) throw new Error(res.error || 'Invalid PIN');
    state.pin = pin; sessionStorage.setItem(KEYS.pinSession, pin); showApp(); await initApp();
  } catch (err) { $('#loginError').textContent = err.message || 'Could not log in.'; }
});
$('#logoutBtn').addEventListener('click', () => { sessionStorage.removeItem(KEYS.pinSession); state.pin = ''; closeDrawer(); showLogin(); });

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.deferredInstallPrompt = event; $('#installBtn').classList.remove('hidden'); });
$('#installBtn').addEventListener('click', async () => {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null; $('#installBtn').classList.add('hidden');
});

window.addEventListener('online', () => { refreshLocalCatalog(); loadReferenceData(); });
window.addEventListener('offline', () => setSyncStatus('Offline • local SKU search still works'));
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pin && navigator.onLine) refreshLocalCatalog(); });
setInterval(() => { if (state.pin && navigator.onLine && !document.hidden) refreshLocalCatalog(); }, 15 * 60 * 1000);

async function initApp() {
  const draft = readDraft();
  state.date = draft?.date || todayISO();
  state.partyName = draft?.partyName || '';
  state.pendingParties = Array.isArray(draft?.pendingParties) ? draft.pendingParties.map(g => ({ id: g.id || uid(), partyName: g.partyName || '', rows: (g.rows || []).map(r => ({ ...rowTemplate(), ...r, id: r.id || uid(), rate: r.rate === 0 ? '' : r.rate })) })) : [];
  state.rows = Array.isArray(draft?.rows) && draft.rows.length ? draft.rows.map(r => ({ ...rowTemplate(), ...r, id: r.id || uid(), rate: r.rate === 0 ? '' : r.rate })) : [rowTemplate()];
  state.batchSentAt = draft?.batchSentAt || '';
  state.batchNeedsUpdate = Boolean(draft?.batchNeedsUpdate);
  $('#purchaseDate').value = state.date;
  renderPartySelect(); renderAll();

  await loadCatalogFromDevice();
  await Promise.allSettled([loadReferenceData(), refreshLocalCatalog({ forceMeta: true })]);
  saveDraft();
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  state.backendUrl = cleanBackendUrl(localStorage.getItem(KEYS.backend) || '');
  state.pin = sessionStorage.getItem(KEYS.pinSession) || '';
  if (!state.backendUrl) return showBackendSetup();
  if (state.pin) {
    try {
      const res = await jsonp('auth', { pin: state.pin }, 20000);
      if (res.ok) { showApp(); await initApp(); return; }
    } catch (_) {}
    state.pin = ''; sessionStorage.removeItem(KEYS.pinSession);
  }
  showLogin();
}

boot();

/* Application wiring for the AIV Bank student SQL console.
 *
 * Design rule enforced throughout this file: no table name and no column name
 * is written in the source. Even the starter query placed in an empty editor is
 * generated at runtime from the first table GET /schema returned, so this file
 * cannot drift from the backend or become a second source of truth about which
 * tables exist (API_CONTRACT.md §9.1 and §9.3).
 */

import { api, apiBase, apiOrigin, isCrossOrigin, setDataset, setUnauthorizedHandler } from './api.js';
import { errorHint, isRetryable, isClientCode } from './errors.js';
import { createEditor, insertAtCursor } from './editor.js';
import { createSchemaPanel } from './schema.js';
import { createResultsPanel } from './results.js';
import { initPanes } from './panes.js';
import { createMartPanel } from './mart.js';
import { createHistoryPanel } from './history.js';
import { createAuthGate } from './authgate.js';
import { isInstructor, roleLabel } from './auth.js';

const CFG = window.AIVB_CONFIG;
const $ = (id) => document.getElementById(id);

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('run-kbd').textContent = IS_MAC ? '⌘+Enter' : 'Ctrl+Enter';

let serverMaxRows = null;
let inflight = null;
let sessionEpoch = 0;
/** Ten dang nhap cua phien hien tai, de to sang dong cua chinh minh trong
 *  bang xep hang. Rong khi chua dang nhap. */
let currentUsername = '';

/* ------------------------------- panels ---------------------------------- */

const results = createResultsPanel({
  gridWrap: $('grid-wrap'),
  metaEl: $('result-meta'),
  truncatedEl: $('truncated'),
  detailEl: $('detail-body'),
});

const martPanel = createMartPanel({
  statusEl: $('mart-status'),
  selectEl: $('mart-select'),
  searchEl: $('mart-search'),
  refreshBtn: $('mart-refresh'),
  gridEl: $('mart-grid'),
  summaryEl: $('mart-summary'),
});

const history = createHistoryPanel({
  listEl: $('history-list'),
  clearBtn: $('clear-history'),
  limit: CFG.historyLimit,
  onPick: (sql) => {
    cm.setValue(sql);
    cm.focus();
    selectTab('result');
  },
});

const schemaPanel = createSchemaPanel({
  listEl: $('table-list'),
  countEl: $('table-count'),
  filterEl: $('table-filter'),
  refreshBtn: $('refresh-schema'),
  onInsert: (name) => insertAtCursor(cm, name),
  onError: (err) => showServiceBanner(err),
});

const cm = createEditor($('sql'), { schemaRef: schemaPanel.ref, onRun: run });

async function loadPractice() {
  const epoch = sessionEpoch;
  $('leaderboard-status').textContent = 'Đang tải…';
  try {
    // 'all' chu khong phai 'week': bang tinh tu thu Hai nen sang thu Hai la gan
    // nhu trong, va cong suc tich luy ca ky khong hien ra o dau.
    const [me, board] = await Promise.all([api.gamificationMe(), api.leaderboard('all')]);
    if (epoch !== sessionEpoch) return;
    const summary = me.summary || {};
    $('reward-stars').textContent = Number(summary.stars || 0).toLocaleString('en-US');
    $('reward-diamonds').textContent = Number(summary.diamonds || 0).toLocaleString('en-US');
    $('reward-streak').textContent = Number(summary.current_streak || 0).toLocaleString('en-US');
    $('reward-today').textContent = Number(summary.today_queries || 0).toLocaleString('en-US');
    const list = $('leaderboard-list');
    list.innerHTML = '';
    if (!(board.entries || []).length) appendEmpty(list, 'Chưa có dữ liệu xếp hạng.');
    else board.entries.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      // Bang chi gom hoc vien (may chu da loc giang vien), nen dong cua chinh
      // minh chi co khi ban la hoc vien - giang vien se khong thay dong nao sang.
      if (item.username === currentUsername) row.classList.add('is-me');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(item.rank);
      const user = document.createElement('strong');
      user.textContent = item.username;
      const metric = document.createElement('span');
      metric.className = 'leaderboard-metric';
      metric.innerHTML = '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" /></svg>';
      metric.appendChild(document.createTextNode(` ${Number(item.stars || 0).toLocaleString('en-US')}`));
      const queries = document.createElement('span');
      queries.className = 'leaderboard-queries';
      queries.textContent = `${Number(item.queries || 0).toLocaleString('en-US')} query`;
      const streak = document.createElement('span');
      streak.className = 'leaderboard-streak';
      // Ky theo lich tra `streak = null` (practice_daily khong biet chuoi ngay).
      // Hien '—' chu khong hien 0: khong co so lieu khac voi chuoi bang khong.
      streak.textContent = item.streak == null ? '—' : `${item.streak} ngày`;
      row.append(rank, user, metric, queries, streak);
      list.appendChild(row);
    });
    $('leaderboard-status').textContent = 'Đã cập nhật';
  } catch (err) {
    if (epoch !== sessionEpoch) return;
    $('leaderboard-status').textContent = err.message || 'Không tải được';
  }
}

async function loadInstructorAnalytics() {
  // Phien hoc vien khong co panel nay trong DOM (xem <template id="tpl-instructor">),
  // nen `null` la trang thai BINH THUONG o day, khong phai loi.
  const dashboard = $('tab-instructor');
  if (!dashboard) return;
  const epoch = sessionEpoch;
  const summaryEl = $('analytics-summary');
  summaryEl.replaceChildren();
  appendEmpty(summaryEl, 'Đang tải số liệu giảng viên…', 'empty empty-loading');
  try {
    const data = await api.instructorAnalytics();
    if (epoch !== sessionEpoch || !document.getElementById('tab-instructor')) return;
    const s = data.summary || {};
    summaryEl.replaceChildren();
    [['Truy vấn', s.query_count], ['Thành công', s.successful_count], ['Bị chặn', s.blocked_count], ['Người dùng', s.active_users], ['TB ms', s.average_elapsed_ms]].forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'analytics-card';
      const metric = document.createElement('strong');
      metric.textContent = Number(value || 0).toLocaleString('vi-VN');
      const caption = document.createElement('span');
      caption.textContent = label;
      card.append(metric, caption);
      summaryEl.appendChild(card);
    });
    const tables = $('analytics-tables');
    tables.replaceChildren();
    const title = document.createElement('h4');
    title.textContent = 'Bảng được dùng nhiều';
    tables.appendChild(title);
    (s.top_tables || []).slice(0, 8).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'analytics-row';
      row.textContent = `${item.name} · ${item.count} truy vấn`;
      tables.appendChild(row);
    });
  } catch (err) {
    if (epoch !== sessionEpoch) return;
    summaryEl.replaceChildren();
    appendEmpty(summaryEl, err.message || 'Không tải được số liệu giảng viên.', 'empty empty-error');
  }
}

/* --------------------------- tab giang vien -------------------------------
 *
 * Phien HOC VIEN khong duoc CO tab nay, chu khong phai khong duoc THAY no.
 * `hidden` chi la mot thuoc tinh: mo devtools go ra la panel hien. O day nut va
 * panel duoc NHAN BAN tu <template> khi va chi khi phien la giang vien, va bi GO
 * KHOI DOM khi khong phai - nen voi hoc vien chung khong ton tai de ma go.
 *
 * Lop thu nhat van la may chu: /admin/analytics/queries co require_instructor va
 * tra 403. Du lieu chua bao gio roi may chu; phan nay chi lo cai vo. */

function mountInstructorTab() {
  if (document.getElementById('tab-instructor')) return;
  const tpl = document.getElementById('tpl-instructor');
  if (!tpl) return;
  const parts = tpl.content.cloneNode(true);
  const button = parts.querySelector('#tab-button-instructor');
  const panel = parts.querySelector('#tab-instructor');
  document.querySelector('.tabs').appendChild(button);
  // Canh cac tabpanel anh em, khong phai cuoi <body>: aria-controls chi dung khi
  // panel that su nam trong vung ket qua.
  // Canh cac tabpanel anh em. Moc vao #tab-result chu khong #tab-progress:
  // tab Tien bo da chuyen thanh khu vuc rieng, con #tab-result thi luon co.
  document.getElementById('tab-result').parentNode.appendChild(panel);
  // Gan o day chu khong o cap module: luc trang tai xong nut nay chua ton tai.
  panel.querySelector('#analytics-refresh')
    .addEventListener('click', () => loadInstructorAnalytics());
}

function unmountInstructorTab() {
  const button = document.getElementById('tab-button-instructor');
  const panel = document.getElementById('tab-instructor');
  // Neu dang dung o tab nay thi phai roi di TRUOC khi go, khong thi con lai mot
  // thanh tab khong nut nao duoc chon.
  if (button && button.classList.contains('is-active')) selectTab('result');
  if (button) button.remove();
  if (panel) panel.remove();
}

/* Tab "Data mart" chi co nghia khi bo du lieu THUC SU co mart. Supply Chain co
 * 20 bang va khong bang nao tien to `mart_`, nen tab do la mot ngo cut: bam vao
 * chi de doc "khong co data mart kha dung".
 *
 * So dem lay tu chinh /schema/marts - vo, no da biet ca bo du lieu lan vai tro,
 * nen ket qua dung voi thu phien nay duoc xem. Mot bang cau hinh tinh "bo nao co
 * mart" se troi khoi su that ngay lan them mart dau tien. */
async function syncMartTab() {
  const button = $('tab-button-mart');
  const count = await martPanel.load();
  if (!button) return;
  const empty = count === 0;
  // Roi khoi tab TRUOC khi an no, khong thi con lai mot panel an ma van la tab
  // dang duoc chon.
  if (empty && button.classList.contains('is-active')) selectTab('result');
  button.hidden = empty;
}

function appendEmpty(parent, message, className = 'empty') {
  const empty = document.createElement('p');
  empty.className = className;
  empty.textContent = message;
  parent.appendChild(empty);
}
/* -------------------------------- tabs ----------------------------------- */

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    const selected = b.dataset.tab === name;
    b.classList.toggle('is-active', selected);
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.tabpanel').forEach((p) => {
    const selected = p.id === 'tab-' + name;
    p.classList.toggle('is-active', selected);
    p.hidden = !selected;
  });
}
/* Uy quyen o `.tabs`, va hoi lai DOM moi lan bam - KHONG chup san mot mang nut.
 *
 * Hai ly do, ca hai deu tung la loi that:
 *
 *   1. Tab Data mart bi AN khi bo du lieu khong co mart nao. Mang chup san van
 *      chua no, nen mui ten se dung o mot tab khong nhin thay va `selectTab` mo
 *      panel cua no ra.
 *   2. Tab Giang vien bi GO KHOI DOM voi phien hoc vien. Mang chup san giu tham
 *      chieu toi mot nut da thao roi: `focus()` vao hu khong, trong tam ban phim
 *      bien mat, va khong co loi nao trong console.
 *
 * Uy quyen con lo them mot viec: nut Giang vien duoc chen SAU khi trang tai xong
 * van nhan duoc su kien, khong phai nho gan tay luc chen. */
const tabStrip = document.querySelector('.tabs');
const liveTabs = () => [...tabStrip.querySelectorAll('.tab')].filter((b) => !b.hidden);

tabStrip.addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button && !button.hidden) selectTab(button.dataset.tab);
});

tabStrip.addEventListener('keydown', (event) => {
  const button = event.target.closest('.tab');
  if (!button) return;
  const tabs = liveTabs();
  const index = tabs.indexOf(button);
  if (index < 0) return;
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  selectTab(tabs[next].dataset.tab);
  tabs[next].focus();
});
selectTab('result');

/* ---------------------------- results fullscreen ------------------------- */

// Display-only state, deliberately not persisted: a reload always comes back
// to the normal layout, so a student cannot get stranded in a mode they do not
// know how to leave.
const expandButton = $('expand-results');

function setResultsMax(on) {
  document.body.classList.toggle('results-max', on);
  expandButton.setAttribute('aria-pressed', String(on));
  expandButton.setAttribute('aria-label', on ? 'Thu nhỏ vùng kết quả' : 'Phóng to vùng kết quả');
  expandButton.title = on ? 'Thu nhỏ vùng kết quả (Esc)' : 'Phóng to vùng kết quả (Esc để thoát)';
  // The editor was display:none while expanded, so CodeMirror measured itself
  // as zero-sized — the same trap as the hidden #app at onSession(). Without
  // this it comes back as a one-line sliver until the window is resized.
  if (!on) cm.refresh();
}

expandButton.addEventListener('click', () => {
  setResultsMax(!document.body.classList.contains('results-max'));
});

/* --------------------------- mobile schema drawer ----------------------- */

const openSchemaButton = $('open-schema');
const closeSchemaButton = $('close-schema');
const schemaBackdrop = $('schema-backdrop');
const schemaSidebar = $('schema-sidebar');
const workspace = document.querySelector('.workspace');
const topbar = document.querySelector('.topbar');
const compactWorkspace = window.matchMedia('(max-width: 900px)');

function setSchemaDrawer(open, restoreFocus = true) {
  if (!compactWorkspace.matches) open = false;
  document.body.classList.toggle('is-schema-open', open);
  openSchemaButton.setAttribute('aria-expanded', String(open));
  schemaBackdrop.hidden = !open;
  schemaSidebar.inert = compactWorkspace.matches && !open;
  schemaSidebar.setAttribute('aria-hidden', String(compactWorkspace.matches && !open));
  workspace.inert = open;
  topbar.inert = open;
  if (open) closeSchemaButton.focus();
  else if (restoreFocus) openSchemaButton.focus();
}

function syncSchemaDrawer() {
  if (compactWorkspace.matches) setSchemaDrawer(false, false);
  else {
    document.body.classList.remove('is-schema-open');
    schemaBackdrop.hidden = true;
    schemaSidebar.inert = false;
    schemaSidebar.removeAttribute('aria-hidden');
    workspace.inert = false;
    topbar.inert = false;
    openSchemaButton.setAttribute('aria-expanded', 'false');
  }
}

openSchemaButton.addEventListener('click', () => setSchemaDrawer(true));
closeSchemaButton.addEventListener('click', () => setSchemaDrawer(false));
schemaBackdrop.addEventListener('click', () => setSchemaDrawer(false));
$('table-list').addEventListener('click', (event) => {
  if (event.target.closest('.tbl-insert') && compactWorkspace.matches) setSchemaDrawer(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (document.body.classList.contains('is-schema-open')) setSchemaDrawer(false);
  else if (document.body.classList.contains('results-max')) setResultsMax(false);
});
compactWorkspace.addEventListener('change', syncSchemaDrawer);
syncSchemaDrawer();

$('progress-refresh').addEventListener('click', () => loadPractice());
// Nut "Lam moi" cua bang giang vien duoc gan trong mountInstructorTab(): o day
// no chua ton tai, va $('analytics-refresh') se la null lam chet ca module.

/* ------------------------------- health ---------------------------------- */

function pill(text, cls = '') {
  const s = document.createElement('span');
  s.className = 'pill ' + cls;
  s.textContent = text;
  return s;
}

async function loadHealth() {
  const box = $('health');
  box.innerHTML = '';
  try {
    const h = await api.health();
    serverMaxRows = h.max_rows;
    const mr = $('max-rows');
    mr.max = String(h.max_rows);
    if (!mr.value) mr.value = String(Math.min(CFG.defaultMaxRows, h.max_rows));

    const healthy = h.status === 'healthy' && h.ok !== false;
    box.appendChild(pill(healthy ? 'Máy chủ sẵn sàng' : 'Máy chủ đang lỗi', healthy ? 'pill-ok' : 'pill-err'));
    // Danh dau: /health tra so bang cua bo du lieu MAC DINH, con nguoi dung
    // co the dang o bo khac. switchDataset() ghi de o duoi. Khong lam vay thi
    // pill nay noi "77 bang" trong khi thanh ben trai noi 20 - va mot trong hai
    // con so do sai, nguoi doc khong biet cai nao.
    const tablePill = pill(`${h.table_count} bảng`, 'pill-muted');
    tablePill.id = 'health-tables';
    box.appendChild(tablePill);
    box.appendChild(pill(`tối đa ${Number(h.max_rows).toLocaleString('en-US')} dòng`, 'pill-muted'));
    box.appendChild(pill(`giới hạn ${h.query_timeout_s}s / truy vấn`, 'pill-muted'));
    box.appendChild(pill(`v${h.version}`, 'pill-muted'));

    if (!healthy) {
      showBanner(
        'Bộ dữ liệu hiện không sẵn sàng nên các truy vấn sẽ báo lỗi. Hãy báo giảng viên hoặc quản trị hệ thống.'
      );
    } else {
      hideBanner();
    }
  } catch (err) {
    box.appendChild(pill('Không kết nối được máy chủ', 'pill-err'));
    showServiceBanner(err);
  }
}

function showServiceBanner(err) {
  if (!err) return;
  if (err.error_code === 'E_CLIENT_NETWORK' || err.error_code === 'E_DB_UNAVAILABLE') {
    // `apiBase()` RONG la cau hinh DUNG cho ban trien khai cung origin, nen in
    // thang no ra cho "(API: )" - mot cho trong khong noi len dieu gi va lam
    // nguoi doc tuong la thieu cau hinh. `apiOrigin()` da roi ve location.origin.
    const where = apiBase() ? apiBase() : `${apiOrigin()} (cùng origin)`;
    showBanner(`${err.message} ${errorHint(err.error_code)} (API: ${where})`);
  }
}

function showBanner(text) {
  const b = $('service-banner');
  b.textContent = text;
  b.hidden = false;
}
function hideBanner() {
  $('service-banner').hidden = true;
}

/* -------------------------------- errors ---------------------------------- */

function clearError() {
  const box = $('error-box');
  box.hidden = true;
  box.innerHTML = '';
}

/**
 * Render one failure.
 *
 * The backend `message` is rendered verbatim as its own block. The extra line
 * below it is generic advice selected by error_code alone (see errors.js). In
 * particular nothing here treats E_UNKNOWN_TABLE as anything other than "that
 * name is not a table you can query" — a restricted table and a typo look
 * identical, which is exactly the intent.
 */
function showError(err, { onRetry } = {}) {
  const box = $('error-box');
  box.hidden = false;
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'err-head';

  const code = document.createElement('span');
  code.className = 'err-code';
  code.textContent = err.error_code || 'E_UNKNOWN';
  head.appendChild(code);

  if (isClientCode(err.error_code)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'lỗi phía trình duyệt';
    head.appendChild(tag);
  } else if (err.http_status) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `HTTP ${err.http_status}`;
    head.appendChild(tag);
  }
  box.appendChild(head);

  if (err.message) {
    const msg = document.createElement('p');
    msg.className = 'err-msg';
    // textContent: the server message is displayed exactly as received.
    msg.textContent = err.message;
    box.appendChild(msg);
  }

  const hint = document.createElement('p');
  hint.className = 'err-hint';
  hint.textContent = errorHint(err.error_code);
  box.appendChild(hint);

  if (isRetryable(err.error_code) && onRetry) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Chạy lại';
    btn.addEventListener('click', onRetry);
    box.appendChild(btn);
  }
}

/* --------------------------------- run ------------------------------------ */

function currentSql() {
  // Running just the selection is the standard way to work through a long
  // scratch file, and it is also the fix we suggest for E_MULTI_STATEMENT.
  const sel = cm.getSelection();
  return (sel && sel.trim() ? sel : cm.getValue()).trim();
}

function setRunning(on) {
  $('run').disabled = on;
  $('stop').hidden = !on;
  $('run-status').textContent = on ? 'Đang chạy…' : '';
  $('run-status').className = 'run-status' + (on ? ' is-running' : '');
}

$('run').addEventListener('click', () => run());
$('stop').addEventListener('click', () => {
  if (inflight) inflight.abort();
});

async function run() {
  if (inflight) return;
  const sql = currentSql();
  selectTab('result');
  clearError();

  let maxRows = parseInt($('max-rows').value, 10);
  if (!Number.isFinite(maxRows) || maxRows < 1) maxRows = CFG.defaultMaxRows;
  if (serverMaxRows) maxRows = Math.min(maxRows, serverMaxRows);
  $('max-rows').value = String(maxRows);

  const controller = new AbortController();
  inflight = controller;
  setRunning(true);
  const t0 = performance.now();

  try {
    const res = await api.query(sql, maxRows, controller.signal);
    const roundTrip = Math.round(performance.now() - t0);
    results.show(res);
    if (res.gamification) { loadPractice(); }
    $('run-status').textContent = `Xong trong ${roundTrip} ms (kể cả truyền dữ liệu)`;
    history.add({
      sql,
      ok: true,
      row_count: res.row_count,
      elapsed_ms: Math.round(Number(res.elapsed_ms) || 0),
    });
  } catch (err) {
    results.clear();
    results.clearDetail();
    showError(err, { onRetry: () => run() });
    $('run-status').textContent = '';
    if (err.error_code !== 'E_CLIENT_ABORTED') {
      history.add({ sql, ok: false, error_code: err.error_code });
    }
    showServiceBanner(err);
  } finally {
    inflight = null;
    setRunning(false);
  }
}

/* ------------------------------- bootstrap -------------------------------- */

/**
 * Put a runnable starter query in an empty editor, built from whatever the API
 * actually returned. Nothing about it is hardcoded; if the dataset changes, so
 * does the starter query.
 */
function seedStarterQuery(schema) {
  if (!schema || !schema.tables.length) return;
  if (cm.getValue().trim()) return;
  // Widest table = the most interesting first look at the data. Chosen from the
  // API response, so this stays correct whatever the dataset contains.
  const table = schema.tables.reduce(
    (best, t) => (t.columns.length > best.columns.length ? t : best),
    schema.tables[0]
  );
  const cols = table.columns.slice(0, 4).map((c) => c.name);
  const projection = cols.length ? cols.join(', ') : '*';
  cm.setValue(`-- Ví dụ mở đầu, được tạo từ danh sách bảng máy chủ trả về.\n` +
    `-- Sửa thoải mái, hoặc bấm một bảng ở thanh bên trái để bắt đầu lại.\n` +
    `SELECT ${projection}\nFROM ${table.name}\nLIMIT 20;`);
}

/* -------------------------------- session --------------------------------- */

/**
 * Everything on screen or in this tab's storage that belongs to one person.
 *
 * Called before showing the login form again after a sign-out, and before
 * handing the console to a DIFFERENT user after a session expiry. The table
 * list is the important one — it is permission-dependent — but the editor,
 * results, run detail and history are the student's work and have no business
 * surviving into someone else's session on a lab machine.
 */
function wipeSessionState() {
  sessionEpoch += 1;
  history.purge();
  schemaPanel.clear();
  results.clear();
  martPanel.clear();
  results.clearDetail();
  clearError();
  cm.setValue('');
  $('run-status').textContent = '';
  $('health').innerHTML = '';
  $('session-box').hidden = true;
  $('session-user').textContent = '';
  $('session-role').textContent = '';
  $('reward-stars').textContent = '0';
  $('reward-diamonds').textContent = '0';
  $('reward-streak').textContent = '0';
  $('reward-today').textContent = '0';
  $('leaderboard-list').replaceChildren();
  appendEmpty($('leaderboard-list'), 'Đăng nhập để xem xếp hạng.');
  $('leaderboard-status').textContent = '';
  currentUsername = '';
  // Go han khoi DOM, khong chi don rong. Dang xuat giang vien roi dang nhap hoc
  // vien tren CUNG MOT TAB trinh duyet la duong sot de nhat: khong go thi phan
  // tu cu con nguyen trong phien moi.
  unmountInstructorTab();
  hideBanner();
  selectTab('result');
}

function renderSessionBar(session) {
  const box = $('session-box');
  const badge = $('session-role');
  const instructor = isInstructor(session);

  currentUsername = session.username || '';
  $('session-user').textContent = currentUsername || '—';
  badge.textContent = roleLabel(session);
  badge.classList.toggle('is-instructor', instructor);
  badge.title = instructor
    ? 'Phiên giảng viên: quyền truy cập do máy chủ quyết định và có thể khác phiên học viên.'
    : 'Phiên học viên.';

  // Three simultaneous signals, on purpose: badge, top-bar colour, and a strip
  // across the page. Missing all three at once takes effort.
  document.body.classList.toggle('role-instructor', instructor);
  if (instructor) mountInstructorTab();
  else unmountInstructorTab();

  box.hidden = false;
}

$('btn-logout').addEventListener('click', () => gate.signOut());
$('btn-change-password').addEventListener('click', () => gate.openChangePassword());

/**
 * A guarded call came back 401. Hide the console immediately and ask for the
 * password again — but do NOT wipe: the SQL in the editor is the student's
 * unsaved work and this is exactly the moment they must not lose it.
 */
setUnauthorizedHandler((reason) => {
  if (inflight) {
    inflight.abort();
    inflight = null;
    setRunning(false);
  }
  if (reason === 'password_change_required') gate.requirePasswordChange();
  else gate.showExpired();
});

const gate = createAuthGate({
  appEl: $('app'),

  /** Server-confirmed session; the console may open. */
  async onSession(session, { sameUser }) {
    // A different person logged in on this tab. Whatever the previous session
    // left behind — table list, results, history, half-written SQL — is theirs,
    // not this user's.
    if (!sameUser) wipeSessionState();
    sessionEpoch += 1;

    renderSessionBar(session);

    // CodeMirror was constructed while #app was hidden, so it measured itself
    // as zero-sized. Without this the editor renders as a one-line sliver on
    // first login and only fixes itself when the window is resized.
    cm.refresh();

    await loadHealth();
    // After loadHealth, which clears the banner on a healthy server.
    warnIfCrossOrigin();

    await loadDatasets();

    const schema = await schemaPanel.load();
    await Promise.all([syncMartTab(), loadPractice(), loadInstructorAnalytics()]);
    seedStarterQuery(schema);
    cm.refresh();
    cm.focus();
  },

  /**
   * Sign-out. The server session is already gone; destroy the client copy too,
   * then reload with location.replace so the console is not sitting in this
   * history entry for the Back button to restore.
   */
  async onSignedOut() {
    wipeSessionState();
    document.body.classList.remove('role-instructor');
    location.replace(location.pathname + location.search);
  },
});

/**
 * A cross-origin API cannot receive the session cookie (credentials is
 * 'same-origin' by contract), so login would succeed and everything after it
 * would 401. Say so plainly instead of letting it look like a flaky server.
 */
function warnIfCrossOrigin() {
  if (!isCrossOrigin()) return;
  showBanner(
    `Giao diện đang gọi API ở khác nguồn (${apiOrigin()}), nên trình duyệt sẽ không gửi ` +
      'cookie phiên và các thao tác sẽ báo hết phiên. Hãy phục vụ giao diện và API trên cùng ' +
      'một origin (xem web/README.md).'
  );
}

/**
 * The Back button can restore this page from the back/forward cache with the
 * old DOM intact, bypassing every script. Re-ask the server on every restore:
 * if the session is gone, the gate closes over the stale console at once.
 */
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  api.me().catch((err) => {
    if (err && err.http_status === 401) {
      wipeSessionState();
      gate.showExpired();
    }
  });
});

/* ===================== SECTION NAV + SQL SANDBOX =====================
 *
 * Three top-level areas. Finance Banking and Supply Chain are this same
 * console pointed at different teaching databases. "Thực hành SQL" is a
 * different animal: it runs DuckDB-WASM in this browser and never contacts
 * the server, so it gets its OWN editor, its own schema reference and its own
 * results panel rather than borrowing the console's.
 *
 * That separation is not tidiness, it is the safety property. The console's
 * autocomplete may only ever be fed by GET /schema (frontend/README.md §4.1,
 * §4.3); the sandbox's may only ever be fed by the student's own files. Two
 * objects, no shared state, no way for a name from one to surface in the other.
 */

const sectionTabs = Array.from(document.querySelectorAll('.section-tab'));
let currentSection = 'finance';

/** section id -> dataset name, filled from GET /datasets. The console NEVER
 *  invents this mapping: the server decides which datasets exist, exactly as it
 *  decides which tables exist. */
const sectionDataset = new Map();

/** Ask the server which datasets this session may use, then dress the section
 *  bar with what it said. A dataset whose database failed to open is shown as
 *  unavailable rather than silently dropped - a missing tab looks like a
 *  feature that was never built, which is the wrong thing to conclude. */
async function loadDatasets() {
  let res;
  try {
    res = await api.datasets();
  } catch (_) {
    // An older server without /datasets: stay single-dataset, which is exactly
    // what that server serves.
    return;
  }
  const list = res.datasets || [];
  sectionDataset.clear();

  // Danh dau THUAN (`data-dataset-slot`), khong phai tru ra tung ngoai le. Cach
  // cu la `filter(b => b.dataset.section !== 'sandbox')`, va no vo ngay khi them
  // khu vuc thu tu: "Bang xep hang" bi coi la mot cho trong cho dataset, bi tat
  // di kem "Chua cau hinh", va dong ghi `.section-tab-sub` nem TypeError vi the
  // do khong co dong phu.
  const dsTabs = sectionTabs.filter((b) => b.hasAttribute('data-dataset-slot'));
  list.slice(0, dsTabs.length).forEach((ds, i) => {
    const btn = dsTabs[i];
    sectionDataset.set(btn.dataset.section, ds.name);
    btn.querySelector('.section-tab-name').textContent = ds.label;
    btn.querySelector('.section-tab-sub').textContent = ds.available
      ? `${ds.table_count} bảng`
      : 'Không kết nối được';
    btn.disabled = !ds.available;
    btn.setAttribute('aria-disabled', ds.available ? 'false' : 'true');
  });
  // A tab with no dataset behind it stays off.
  dsTabs.slice(list.length).forEach((btn) => {
    btn.disabled = true;
    btn.querySelector('.section-tab-sub').textContent = 'Chưa cấu hình';
  });

  setDataset(sectionDataset.get(currentSection) || res.default || null);
}

/** Move the console to another dataset.
 *
 * Everything the previous dataset put on screen has to go, and for a reason
 * beyond tidiness: the editor's autocomplete is fed by the schema panel, so a
 * stale schema would offer Finance Banking table names inside a Supply Chain
 * query. That is the same leak frontend/README.md rules 1 and 3 exist to stop.
 */
async function switchDataset(name) {
  setDataset(name);

  // Moi thu tren man hinh dang noi ve bo du lieu CU. Sua truoc khi tai lai, de
  // khong co khoanh khac nao hien so cua bo nay canh ten cua bo kia.
  const tab = sectionTabs.find((b) => sectionDataset.get(b.dataset.section) === name);
  const label = tab ? tab.querySelector('.section-tab-name').textContent : '';
  const sub = document.querySelector('.brand-text small');
  if (sub && label) sub.textContent = label;

  schemaPanel.clear();
  martPanel.clear();
  results.clear();
  results.clearDetail();
  history.purge();
  clearError();
  hideBanner();
  cm.setValue('');
  $('run-status').textContent = '';
  selectTab('result');

  const schema = await schemaPanel.load();
  await syncMartTab();
  seedStarterQuery(schema);
  const pillEl = $('health-tables');
  if (pillEl && schema) pillEl.textContent = `${schema.tables.length} bảng`;
  cm.refresh();
}

/** Lazily built on first entry to the sandbox; null until then. */
let sandboxUi = null;

function selectSection(name) {
  const target = sectionTabs.find((b) => b.dataset.section === name);
  if (!target || target.disabled || name === currentSection) return;

  currentSection = name;
  for (const b of sectionTabs) {
    const on = b.dataset.section === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }

  const inSandbox = name === 'sandbox';
  const inBoard = name === 'leaderboard';
  const inConsole = !inSandbox && !inBoard;

  // Mot bang tra cuu, khong phai mot chuoi if long nhau. Them khu vuc thu tu da
  // lam lo ra kieu cu: no chi biet "sandbox hay khong", nen khu vuc moi se hien
  // DE LEN console thay vi thay the no.
  const WORKSPACES = {
    finance: 'main-workspace',
    scm: 'main-workspace',
    sandbox: 'sandbox-workspace',
    leaderboard: 'leaderboard-workspace',
  };
  const shown = WORKSPACES[name];
  for (const id of new Set(Object.values(WORKSPACES))) $(id).hidden = id !== shown;

  // Phu de o thanh tren phai noi ve khu vuc DANG mo. De nguyen ten bo du lieu
  // khi da sang khu vuc khac la noi sai: chung khong dung bo du lieu nao ca.
  const sub = document.querySelector('.brand-text small');
  if (sub && inSandbox) sub.textContent = 'Dữ liệu của bạn, chạy trên máy bạn';
  if (sub && inBoard) sub.textContent = 'Toàn lớp, tính từ trước tới nay';
  // The schema drawer belongs to the console only.
  $('open-schema').hidden = !inConsole;
  if (!inConsole) setSchemaDrawer(false);

  const ds = sectionDataset.get(name);
  if (ds && ds !== undefined) switchDataset(ds);

  if (inSandbox) {
    ensureSandbox();
    // CodeMirror measures 0px while its container is hidden -- the same trap
    // the console hits behind the login gate (see refresh() calls after boot).
    if (sandboxUi) requestAnimationFrame(() => sandboxUi.cm.refresh());
  } else if (inBoard) {
    // Nap lai moi lan vao: diem doi sau moi query, va nguoi xem vao day chinh la
    // de xem con so MOI. Mot bang cu dung im thi te hon la khong co bang.
    loadPractice();
  } else {
    requestAnimationFrame(() => cm.refresh());
  }
}

for (const b of sectionTabs) {
  b.addEventListener('click', () => selectSection(b.dataset.section));
}
$('sections').addEventListener('keydown', (e) => {
  const keys = { ArrowRight: 1, ArrowLeft: -1 };
  if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
  const usable = sectionTabs.filter((b) => !b.disabled);
  const i = usable.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = usable.length - 1;
  else next = (i + keys[e.key] + usable.length) % usable.length;
  usable[next].focus();
  selectSection(usable[next].dataset.section);
});

/* --------------------------- the sandbox itself --------------------------- */

function ensureSandbox() {
  if (sandboxUi) return sandboxUi;

  const statusEl = $('sandbox-status');
  const errEl = $('sandbox-error');
  const listEl = $('sandbox-tables');
  const countEl = $('sandbox-count');
  const dropEl = $('sandbox-drop');
  const fileEl = $('sandbox-file');
  const runBtn = $('sandbox-run');
  const resetBtn = $('sandbox-reset');

  const progressEl = $('sandbox-progress');

  /** MB voi mot chu so thap phan, dau phay theo kieu Viet. */
  const mb = (n) => (n / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 });

  /* Nhan mot { text, loaded, total } chu khong phai chuoi tran, vi viec "nap mot
   * file" di qua ba giai doan dai ngan rat khac nhau:
   *
   *   1. tai cong cu SQL (34 MB)   ~11s lan dau   -> co total
   *   2. doc file vao bo nho       tuc thi ... vai giay -> co total
   *   3. tao bang, dem dong        khong do duoc  -> khong co total
   *
   * Thieu `total` thi <progress> tu chuyen sang dang chay vo dinh, dung thu giai
   * doan 3 can. Neu thanh chi do giai doan 2 thi voi file 2 MB no loe mot cai
   * roi tat, con 11 giay kia van la vong quay cam. */
  const setStatus = (s) => {
    const info = typeof s === 'string' ? { text: s } : s || {};
    const { text = '', loaded, total } = info;

    if (!text) {
      statusEl.textContent = '';
      progressEl.hidden = true;
      progressEl.removeAttribute('value');
      return;
    }

    if (Number.isFinite(total) && total > 0) {
      const done = Math.min(Number(loaded) || 0, total);
      progressEl.value = done / total;
      statusEl.textContent = `${text} ${mb(done)}/${mb(total)} MB (${Math.round((done / total) * 100)}%)`;
    } else {
      progressEl.removeAttribute('value'); // vo dinh
      statusEl.textContent = text;
    }
    progressEl.hidden = false;
  };
  const clearErr = () => {
    errEl.hidden = true;
    errEl.textContent = '';
  };
  /* Verbatim, and deliberately so. The "never reinterpret the message" rule
   * exists to stop the console leaking whether a teaching table exists; here
   * the message is about the student's own file, so plain truth is the most
   * useful thing we can show. */
  const showErr = (message) => {
    errEl.hidden = false;
    errEl.textContent = String(message);
  };

  const sbResults = createResultsPanel({
    gridWrap: $('sandbox-grid'),
    metaEl: $('sandbox-meta'),
    truncatedEl: $('sandbox-truncated'),
    source: 'local',
    filename: 'ket-qua-sql',
  });

  // Built from the loaded files, in exactly the shape editor.js expects from
  // GET /schema -- so the student gets the same autocomplete over their own
  // tables, with no second implementation.
  let sbSchema = { tables: [] };
  const sbSchemaRef = {
    get value() {
      return sbSchema;
    },
  };

  let engine = null; // the createSandbox() handle, once sandbox.js has loaded

  async function engineReady() {
    if (engine) return engine;
    const mod = await import('./sandbox.js');
    engine = mod.createSandbox({ onStatus: setStatus });
    return engine;
  }

  const sbCm = createEditor($('sandbox-sql'), {
    schemaRef: sbSchemaRef,
    onRun: () => runSandbox(),
  });
  $('sandbox-kbd').textContent = IS_MAC ? '⌘+Enter' : 'Ctrl+Enter';

  function renderTables() {
    const tables = engine ? engine.tables() : [];
    sbSchema = {
      tables: tables.map((t) => ({ name: t.table, columns: t.columns })),
    };
    countEl.textContent = tables.length ? `(${tables.length})` : '';
    resetBtn.hidden = !tables.length;
    runBtn.disabled = !tables.length;
    listEl.replaceChildren();

    if (!tables.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Chưa có file nào.';
      listEl.appendChild(p);
      return;
    }

    for (const t of tables) {
      const card = document.createElement('div');
      card.className = 'sbtable';

      const head = document.createElement('div');
      head.className = 'sbtable-head';
      const name = document.createElement('span');
      name.className = 'sbtable-name';
      name.textContent = t.table;
      const rows = document.createElement('span');
      rows.className = 'sbtable-rows';
      rows.textContent = `${t.rows.toLocaleString('en-US')} dòng`;
      head.append(name, rows);

      const file = document.createElement('div');
      file.className = 'sbtable-file';
      file.textContent = t.file;

      const cols = document.createElement('div');
      cols.className = 'sbtable-cols';
      cols.textContent = t.columns.map((c) => c.name).join(', ');
      cols.title = t.columns.map((c) => `${c.name} — ${c.type}`).join('\n');

      card.append(head, file, cols);
      listEl.appendChild(card);
    }
  }

  async function takeFiles(fileList) {
    if (!fileList || !fileList.length) return;
    clearErr();
    // Bao TEN FILE truoc bat cu thu gi khac. `engineReady()` ben duoi co the mat
    // hon 10 giay o lan dau (34 MB engine), va neu nhan dau tien noi ve "cong cu
    // SQL" thi nguoi vua tha file khong co bang chung nao rang cu tha do duoc ghi
    // nhan - dung cai cam giac "quay quay chu khong thay gi".
    const picked = Array.from(fileList);
    const mb1 = (n) => (n / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 });
    setStatus({
      text:
        picked.length === 1
          ? `Đã nhận ${picked[0].name} · ${mb1(picked[0].size)} MB`
          : `Đã nhận ${picked.length} file`,
    });
    dropEl.classList.add('is-busy');
    try {
      const eng = await engineReady();
      const { added, failed } = await eng.addFiles(fileList);
      renderTables();
      if (added.length && !sbCm.getValue().trim()) sbCm.setValue(eng.starterSql());
      if (failed.length) {
        showErr(failed.map((f) => f.message).join('\n'));
      }
    } catch (err) {
      showErr(err?.message || String(err));
    } finally {
      dropEl.classList.remove('is-busy');
      setStatus('');
    }
  }

  async function runSandbox() {
    const sel = sbCm.getSelection();
    const sql = (sel && sel.trim() ? sel : sbCm.getValue()).trim();
    if (!sql) return;
    clearErr();
    runBtn.disabled = true;
    setStatus({ text: 'Đang chạy…' });
    try {
      const eng = await engineReady();
      const res = await eng.run(sql);
      sbResults.show(res);
      if (res._downloadTruncated) {
        showErr(
          `Truy vấn trả về ${res._totalRows.toLocaleString('en-US')} dòng; ` +
            'chỉ giữ được 1.000.000 dòng đầu để hiển thị và tải về. ' +
            'Thêm WHERE hoặc LIMIT để lấy đúng phần bạn cần.'
        );
      }
    } catch (err) {
      sbResults.clear();
      showErr(err?.message || String(err));
    } finally {
      runBtn.disabled = !(engine && engine.tables().length);
      setStatus('');
    }
  }

  dropEl.addEventListener('click', () => fileEl.click());
  dropEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileEl.click();
    }
  });
  fileEl.addEventListener('change', () => {
    // Copy the FileList BEFORE clearing the input. `fileEl.files` is a LIVE
    // list: setting `.value = ''` empties it. takeFiles is async, so it only
    // runs as far as its first `await` before yielding -- and by the time it
    // came back to read the list, the line below had already emptied it, so
    // nothing ever loaded. Clearing is still needed (otherwise re-picking the
    // same file fires no `change`), it just has to happen after the snapshot.
    const picked = Array.from(fileEl.files);
    fileEl.value = '';
    takeFiles(picked);
  });

  for (const type of ['dragenter', 'dragover']) {
    dropEl.addEventListener(type, (e) => {
      e.preventDefault();
      dropEl.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropEl.addEventListener(type, (e) => {
      e.preventDefault();
      dropEl.classList.remove('is-over');
    });
  }
  dropEl.addEventListener('drop', (e) => takeFiles(e.dataTransfer?.files));
  // A file dropped anywhere else would otherwise navigate the tab away from the
  // console and lose whatever the student had typed.
  for (const type of ['dragover', 'drop']) {
    $('sandbox-workspace').addEventListener(type, (e) => {
      if (!dropEl.contains(e.target)) e.preventDefault();
    });
  }

  runBtn.addEventListener('click', () => runSandbox());
  resetBtn.addEventListener('click', async () => {
    if (engine) await engine.reset();
    renderTables();
    sbResults.clear();
    clearErr();
    setStatus('');
  });

  renderTables();
  sandboxUi = { cm: sbCm, reset: async () => {
    if (engine) await engine.reset();
    renderTables();
    sbResults.clear();
    clearErr();
  } };
  return sandboxUi;
}


// Khoi phuc kich thuoc khung da nho, va gan hai thanh keo.
initPanes();

gate.boot();

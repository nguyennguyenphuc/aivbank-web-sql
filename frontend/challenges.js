/* Khu vuc "Luyen SQL": bai tap kieu HackerRank, cham tren may chu.
 *
 * Ba cot: danh sach bai | de bai (De bai, Nghiep vu, So do, Bang xep hang) |
 * editor + ket qua + phan dinh. Bo cuc tham khao trang lam bai cua HackerRank
 * (khao sat bang REA 2026-11-07: breadcrumb, de + bang mo ta cot, editor voi
 * Run/Submit, thong tin do kho / diem), noi dung la cua bo du lieu cua lop.
 *
 * Nguon su that:
 *   - de bai, gui y, phan nghiep vu: GET /challenges/{id} (khong co dap an);
 *   - chay thu bai SELECT: POST /query voi dataset cua bai (giong console);
 *   - bai UPDATE/DELETE: bang mau GET /challenges/{id}/sample, chay trong
 *     DuckDB-WASM (sandbox.js createChallengeEngine), nop TRANG THAI bang;
 *   - cham: POST /challenges/{id}/submit. Khi sai chi co CON SO, khong co dong
 *     nao cua dap an.
 * Cung phien dang nhap web; khong co tai khoan rieng cho khu vuc nay.
 */

import { api } from './api.js';
import { errorHint } from './errors.js';
import { createEditor } from './editor.js';
import { createResultsPanel } from './results.js';
import { createErdPanel } from './erd.js';
import { initChallengePanes } from './panes.js';

const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', difficult: 'Difficult', advanced: 'Advanced' };
const LEVELS = Object.keys(LEVEL_LABEL);

/* Mot dong co dinh duoi "Dieu rut ra", thay cho cau "day la du lieu sinh" ma
 * vong review 2 bat bo khoi tung takeaway. */
const DATA_NOTE = {
  scm: 'Giá, chi phí, tồn kho, PO, chuyến giao và last-mile là dữ liệu sinh cho khoá học: so sánh và thứ hạng có ý nghĩa, số tuyệt đối thì không.',
};

function takeawayNote(domain) {
  return DATA_NOTE[domain] ? h('p', 'ch-data-note', DATA_NOTE[domain]) : null;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function createChallengesUi(root) {
  root.innerHTML = `
    <aside class="ch-list-col" aria-label="Danh sách bài">
      <div class="ch-list-head">
        <h2 class="ch-heading">Luyện SQL</h2>
        <dl class="ch-score">
          <div><dt>Điểm của bạn</dt><dd class="ch-my-points">0</dd></div>
          <div><dt>Đã giải</dt><dd class="ch-my-solved">0</dd></div>
        </dl>
      </div>
      <div class="ch-filters">
        <label class="ch-field">Lĩnh vực<select class="filter ch-domain"></select></label>
        <div class="ch-levels" role="group" aria-label="Độ khó"></div>
        <label class="ch-field">Trạng thái
          <select class="filter ch-status">
            <option value="">Tất cả</option>
            <option value="todo">Chưa giải</option>
            <option value="done">Đã giải</option>
          </select>
        </label>
      </div>
      <ul class="ch-list" aria-label="Các bài"></ul>
    </aside>
    <div class="pane-sep pane-sep-v ch-sep-list" data-ch-resize="list" role="separator"
         aria-orientation="vertical" tabindex="0"
         aria-label="Kéo để đổi bề rộng danh sách bài, mũi tên trái/phải, nhấn đúp để về mặc định"></div>
    <div class="pane-sep pane-sep-v ch-sep-problem" data-ch-resize="problem" role="separator"
         aria-orientation="vertical" tabindex="0"
         aria-label="Kéo để đổi bề rộng khung đề bài, mũi tên trái/phải, nhấn đúp để về mặc định"></div>

    <section class="ch-problem" aria-label="Đề bài">
      <p class="empty ch-placeholder">Chọn một bài ở cột bên trái để bắt đầu.</p>
      <div class="ch-problem-body" hidden>
        <nav class="ch-crumb" aria-label="Vị trí"></nav>
        <h2 class="ch-title"></h2>
        <div class="ch-meta"></div>
        <div class="subtabs ch-tabs" role="tablist" aria-label="Nội dung bài">
          <button class="subtab is-active" type="button" role="tab" data-ch-tab="statement" aria-selected="true">Đề bài</button>
          <button class="subtab" type="button" role="tab" data-ch-tab="lesson" aria-selected="false" tabindex="-1">Nghiệp vụ</button>
          <button class="subtab" type="button" role="tab" data-ch-tab="erd" aria-selected="false" tabindex="-1">Sơ đồ</button>
          <button class="subtab" type="button" role="tab" data-ch-tab="board" aria-selected="false" tabindex="-1">Bảng xếp hạng</button>
        </div>
        <div class="ch-pane" data-ch-pane="statement" role="tabpanel"></div>
        <div class="ch-pane" data-ch-pane="lesson" role="tabpanel" hidden></div>
        <div class="ch-pane ch-pane-erd" data-ch-pane="erd" role="tabpanel" hidden></div>
        <div class="ch-pane" data-ch-pane="board" role="tabpanel" hidden></div>
      </div>
    </section>

    <section class="ch-work" aria-label="Viết và nộp bài">
      <div class="editor-panel panel ch-editor-panel">
        <div class="toolbar">
          <button type="button" class="btn btn-ghost ch-run" disabled>Chạy thử</button>
          <button type="button" class="btn btn-primary ch-submit" disabled>Nộp bài</button>
          <button type="button" class="btn btn-ghost btn-sm ch-reload" hidden>Nạp lại bảng mẫu</button>
          <span class="spacer"></span>
          <span class="run-status ch-runstatus" role="status" aria-live="polite"></span>
          <button type="button" class="icon-btn ch-expand" aria-pressed="false"
                  aria-label="Phóng to khung làm bài toàn màn hình"
                  title="Phóng to toàn màn hình (Esc để thoát)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path class="ch-expand-icon" d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>
          </button>
        </div>
        <label class="sr-only" for="ch-sql">Câu SQL cho bài đang chọn</label>
        <textarea id="ch-sql"></textarea>
      </div>
      <div class="pane-sep pane-sep-h ch-sep-editor" data-ch-resize="editor" role="separator"
           aria-orientation="horizontal" tabindex="0"
           aria-label="Kéo để đổi chiều cao ô soạn thảo, mũi tên lên/xuống, nhấn đúp để về mặc định"></div>
      <div class="ch-verdict" role="status" aria-live="polite" hidden></div>
      <div class="results-panel panel">
        <div class="errorbox ch-error" hidden></div>
        <div class="result-meta ch-result-meta" hidden></div>
        <div class="banner banner-info ch-truncated" hidden></div>
        <div class="grid-wrap ch-grid"><p class="empty">Kết quả chạy thử hiện ở đây.</p></div>
      </div>
    </section>`;

  const q = (s) => root.querySelector(s);
  initChallengePanes(root);
  const listEl = q('.ch-list');
  const domainEl = q('.ch-domain');
  const levelsEl = q('.ch-levels');
  const statusFilterEl = q('.ch-status');
  const body = q('.ch-problem-body');
  const placeholder = q('.ch-placeholder');
  const runBtn = q('.ch-run');
  const submitBtn = q('.ch-submit');
  const reloadBtn = q('.ch-reload');
  const statusEl = q(".ch-runstatus");
  const verdictEl = q('.ch-verdict');
  const errEl = q('.ch-error');

  let domain = null;
  let level = '';
  let catalogue = [];
  let current = null; // bai dang mo (ban cong khai tu may chu)
  let schema = null; // GET /schema cua dataset cua domain, cho "Bang dung" va goi y
  let engine = null; // DuckDB cho bai dml, tao luoi
  let sampleInfo = null; // {table, columns, column_types, rows}
  let hintShown = 0;
  let inflight = null;
  let epoch = 0;

  const resultsServer = createResultsPanel({
    gridWrap: q('.ch-grid'), metaEl: q('.ch-result-meta'), truncatedEl: q('.ch-truncated'), filename: 'luyen-sql',
  });
  const resultsLocal = createResultsPanel({
    gridWrap: q('.ch-grid'), metaEl: q('.ch-result-meta'), truncatedEl: q('.ch-truncated'),
    source: 'local', filename: 'luyen-sql',
  });

  // Goi y ten bang / cot: bai SELECT dung schema cua dataset, bai dml dung bang mau.
  const schemaRef = {
    get value() {
      if (current && current.kind === 'dml' && sampleInfo) {
        return { tables: [{ name: sampleInfo.table, columns: sampleInfo.columns.map((c, i) => ({ name: c, type: sampleInfo.column_types[i] })) }] };
      }
      return schema;
    },
  };
  const cm = createEditor(q('#ch-sql'), { schemaRef, onRun: () => run() });

  const erd = createErdPanel({
    root: q('.ch-pane-erd'),
    load: async () => {
      if (!current) return { tables: [] };
      const s = schema || (await loadSchema());
      const keep = new Set(current.tables);
      const rel = await api.relationships(datasetOf(current));
      return {
        tables: (s.tables || []).filter((t) => keep.has(t.name)),
        relationships: (rel.relationships || []).filter((r) => keep.has(r.from_table) && keep.has(r.to_table)),
        note: current.tables.length > 1 ? '' : 'Bài này chỉ dùng một bảng.',
      };
    },
    title: () => (current ? `Bảng của bài: ${current.tables.join(', ')}` : ''),
    actionLabel: 'Chèn',
    onUse: (sql) => {
      cm.replaceSelection(sql + '\n');
      cm.focus();
      return 'Đã chèn';
    },
  });

  runBtn.addEventListener('click', () => run());
  submitBtn.addEventListener('click', () => submit());
  reloadBtn.addEventListener('click', () => loadSample(true));
  domainEl.addEventListener('change', () => {
    domain = domainEl.value;
    schema = null;
    renderList();
  });
  statusFilterEl.addEventListener('change', renderList);
  wireTabs();

  /* ------------------------------------------------------------- data -- */

  const datasetOf = (ch) => {
    const d = (catalogue.domains || []).find((x) => x.domain === (ch ? ch.domain : domain));
    return d ? d.dataset : domain;
  };

  async function loadSchema() {
    try {
      schema = await api.schema(datasetOf(current));
    } catch (_) {
      schema = { tables: [] };
    }
    return schema;
  }

  /** Lan dau mo khu vuc, va sau moi lan dang nhap lai. */
  async function init() {
    const my = ++epoch;
    listEl.replaceChildren(h('li', 'empty empty-loading', 'Đang tải danh sách bài…'));
    try {
      const res = await api.challenges();
      if (my !== epoch) return;
      catalogue = res;
      domainEl.replaceChildren(...(res.domains || []).map((d) => {
        const o = h('option', '', d.label);
        o.value = d.domain;
        return o;
      }));
      domain = domain && res.domains.some((d) => d.domain === domain) ? domain : (res.domains[0] || {}).domain;
      domainEl.value = domain || '';
      renderLevels();
      renderScore();
      renderList();
    } catch (err) {
      if (my !== epoch) return;
      listEl.replaceChildren(h('li', 'empty empty-error', `${err.message || 'Không tải được danh sách bài.'} ${errorHint(err.error_code)}`));
    }
  }

  function renderScore() {
    q('.ch-my-points').textContent = String(catalogue.my_points || 0);
    q('.ch-my-solved').textContent = `${catalogue.my_solved || 0} / ${(catalogue.challenges || []).length}`;
  }

  function renderLevels() {
    levelsEl.replaceChildren();
    for (const lv of ['', ...LEVELS]) {
      const b = h('button', 'ch-level-btn', lv ? LEVEL_LABEL[lv] : 'Tất cả');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(lv === level));
      b.addEventListener('click', () => {
        level = lv;
        renderLevels();
        renderList();
      });
      levelsEl.appendChild(b);
    }
  }

  function renderList() {
    const st = statusFilterEl.value;
    const items = (catalogue.challenges || []).filter(
      (c) => c.domain === domain && (!level || c.level === level) &&
        (!st || (st === 'done' ? c.solved : !c.solved))
    );
    listEl.replaceChildren();
    if (!items.length) {
      listEl.appendChild(h('li', 'empty', 'Không có bài nào khớp bộ lọc.'));
      return;
    }
    for (const c of items) {
      const li = h('li');
      const b = h('button', 'ch-item' + (current && current.id === c.id ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('aria-current', current && current.id === c.id ? 'true' : 'false');
      b.appendChild(h('span', 'ch-item-title', c.title));
      const meta = h('span', 'ch-item-meta');
      meta.appendChild(h('span', `ch-level is-${c.level}`, LEVEL_LABEL[c.level]));
      meta.appendChild(h('span', 'ch-item-topic', c.topic));
      meta.appendChild(h('span', 'ch-item-points', `${c.points} điểm`));
      if (c.solved) meta.appendChild(h('span', 'tag tag-solved', 'Đã giải'));
      b.appendChild(meta);
      b.addEventListener('click', () => open(c.id));
      li.appendChild(b);
      listEl.appendChild(li);
    }
  }

  /* --------------------------------------------------------- one problem -- */

  async function open(id) {
    const my = ++epoch;
    setStatus('Đang mở bài…');
    try {
      const res = await api.challenge(id);
      if (my !== epoch) return;
      current = res.challenge;
    } catch (err) {
      setStatus('');
      showError(err);
      return;
    }
    hintShown = 0;
    sampleInfo = null;
    verdictEl.hidden = true;
    clearError();
    resultsServer.clear();
    placeholder.hidden = true;
    body.hidden = false;
    runBtn.disabled = false;
    submitBtn.disabled = false;
    reloadBtn.hidden = current.kind !== 'dml';
    cm.setValue(
      current.kind === 'dml'
        ? `-- Bảng mẫu tên ${current.sample_table} đang nằm trong trình duyệt của bạn.\n-- Viết UPDATE / DELETE, xem lại bằng SELECT, rồi bấm Nộp bài.\n`
        : '-- Viết câu SELECT của bạn ở đây, Chạy thử để xem kết quả, rồi Nộp bài.\n'
    );
    setStatus('');
    renderProblem();
    renderList();
    selectTab('statement');
    erd.clear();
    if (!schema) loadSchema().then(() => current && renderTables());
    if (current.kind === 'dml') loadSample(false);
    requestAnimationFrame(() => cm.refresh());
  }

  function renderProblem() {
    const c = current;
    const dom = (catalogue.domains || []).find((d) => d.domain === c.domain);
    const crumb = q('.ch-crumb');
    crumb.replaceChildren(
      h('span', '', dom ? dom.label : c.domain),
      h('span', 'ch-crumb-sep', '/'),
      h('span', '', LEVEL_LABEL[c.level]),
      h('span', 'ch-crumb-sep', '/'),
      h('span', 'ch-crumb-here', c.title)
    );
    q('.ch-title').textContent = c.title;
    const meta = q('.ch-meta');
    meta.replaceChildren(
      h('span', `ch-level is-${c.level}`, LEVEL_LABEL[c.level]),
      h('span', '', c.topic),
      h('span', '', `${c.points} điểm`),
      ...(c.kind === 'dml' ? [h('span', 'tag', 'Chạy trong trình duyệt')] : []),
      ...(c.solved ? [h('span', 'tag tag-solved', 'Đã giải')] : [])
    );

    const st = q('[data-ch-pane="statement"]');
    st.replaceChildren();
    st.appendChild(h('p', 'ch-statement', c.statement));
    if (c.output) {
      st.appendChild(h('h3', 'ch-sub', 'Kết quả cần trả về'));
      st.appendChild(h('p', 'ch-output', c.output));
    }
    st.appendChild(h('h3', 'ch-sub', 'Bảng dùng trong bài'));
    st.appendChild(h('div', 'ch-tables'));
    renderTables();
    if (c.hints && c.hints.length) {
      st.appendChild(h('h3', 'ch-sub', 'Gợi ý'));
      const ol = h('ol', 'ch-hints');
      st.appendChild(ol);
      const more = h('button', 'btn btn-ghost btn-sm ch-hint-more');
      more.type = 'button';
      st.appendChild(more);
      const paint = () => {
        ol.replaceChildren(...c.hints.slice(0, hintShown).map((t) => h('li', '', t)));
        more.hidden = hintShown >= c.hints.length;
        more.textContent = `Xem gợi ý ${hintShown + 1} / ${c.hints.length}`;
      };
      more.addEventListener('click', () => {
        hintShown += 1;
        paint();
      });
      paint();
    }
    renderLesson();
  }

  /** "Bang dung" kieu HackerRank: moi bang mot o Cot | Kieu, lay tu /schema. */
  function renderTables() {
    const box = q('.ch-tables');
    if (!box || !current) return;
    box.replaceChildren();
    const byName = new Map(((schema && schema.tables) || []).map((t) => [t.name, t]));
    for (const name of current.tables) {
      const t = byName.get(name);
      const fig = h('figure', 'ch-table');
      fig.appendChild(h('figcaption', 'ch-table-name', name));
      if (!t) {
        fig.appendChild(h('p', 'muted', schema ? 'Không có trong danh mục của bạn.' : 'Đang tải cột…'));
      } else {
        const tbl = h('table', 'ch-cols');
        const head = h('tr');
        head.append(h('th', '', 'Cột'), h('th', '', 'Kiểu'));
        tbl.appendChild(h('thead')).appendChild(head);
        const tb = h('tbody');
        for (const col of t.columns) {
          const tr = h('tr');
          const name = h('td');
          name.appendChild(h('code', '', col.name));
          if (col.primary_key) name.appendChild(h('span', 'tag tag-pk', 'PK'));
          tr.append(name, h('td', 'muted', col.type));
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
        fig.appendChild(tbl);
      }
      box.appendChild(fig);
    }
  }

  function renderLesson() {
    const c = current;
    const box = q('[data-ch-pane="lesson"]');
    box.replaceChildren();
    const l = c.lesson || {};
    const dl = h('dl', 'ch-lesson');
    for (const [k, label] of [['concept', 'Khái niệm'], ['formula', 'Công thức'], ['why', 'Vì sao quan trọng'], ['used_in', 'Dùng ở đâu']]) {
      if (!l[k]) continue;
      dl.append(h('dt', '', label), h('dd', '', l[k]));
    }
    box.appendChild(dl);
    box.appendChild(h('h3', 'ch-sub', 'Điều rút ra'));
    box.appendChild(
      c.takeaway
        ? h('p', 'ch-takeaway', c.takeaway)
        : h('p', 'muted', 'Giải đúng bài này để mở phần rút ra: con số trong kết quả nói gì về doanh nghiệp.')
    );
    const note = c.takeaway && takeawayNote(c.domain);
    if (note) box.appendChild(note);
  }

  async function renderBoard() {
    const box = q('[data-ch-pane="board"]');
    box.replaceChildren(h('p', 'empty empty-loading', 'Đang tải bảng xếp hạng…'));
    try {
      const res = await api.challengeLeaderboard(domain);
      box.replaceChildren();
      if (!res.entries.length) {
        box.appendChild(h('p', 'empty', 'Chưa có học viên nào giải bài trong lĩnh vực này.'));
        return;
      }
      const tbl = h('table', 'ch-board');
      const head = h('tr');
      head.append(h('th', '', 'Hạng'), h('th', '', 'Học viên'), h('th', 'num', 'Điểm'), h('th', 'num', 'Số bài'));
      tbl.appendChild(h('thead')).appendChild(head);
      const tb = h('tbody');
      for (const e of res.entries) {
        const tr = h('tr');
        tr.append(h('td', 'num', String(e.rank)), h('td', '', e.username), h('td', 'num', String(e.points)), h('td', 'num', String(e.solved)));
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      box.appendChild(tbl);
    } catch (err) {
      box.replaceChildren(h('p', 'empty empty-error', `${err.message || 'Không tải được.'} ${errorHint(err.error_code)}`));
    }
  }

  /* ---------------------------------------------------------- tabs ------ */

  function wireTabs() {
    const tabs = [...root.querySelectorAll('.ch-tabs .subtab')];
    root.querySelector('.ch-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.subtab');
      if (b) selectTab(b.dataset.chTab);
    });
    root.querySelector('.ch-tabs').addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (i < 0 || next === undefined) return;
      e.preventDefault();
      const b = tabs[(next + tabs.length) % tabs.length];
      b.focus();
      selectTab(b.dataset.chTab);
    });
  }

  function selectTab(name) {
    for (const b of root.querySelectorAll('.ch-tabs .subtab')) {
      const on = b.dataset.chTab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of root.querySelectorAll('.ch-pane')) p.hidden = p.dataset.chPane !== name;
    if (name === 'erd') requestAnimationFrame(() => erd.show());
    if (name === 'board') renderBoard();
  }

  /* --------------------------------------------------- dml: bang mau ---- */

  async function getEngine() {
    if (!engine) {
      const mod = await import('./sandbox.js');
      engine = mod.createChallengeEngine({ onStatus: (s) => setStatus(typeof s === 'string' ? s : s.text || '') });
    }
    return engine;
  }

  async function loadSample(reset) {
    if (!current || current.kind !== 'dml') return;
    const ch = current;
    setStatus(reset ? 'Đang nạp lại bảng mẫu…' : 'Đang chuẩn bị bảng mẫu (lần đầu tải công cụ SQL, mất vài giây)…');
    try {
      const s = await api.challengeSample(ch.id);
      const eng = await getEngine();
      await eng.loadRows(s.table, s.columns, s.column_types, s.rows);
      if (current !== ch) return;
      sampleInfo = s;
      setStatus(`Bảng mẫu ${s.table}: ${s.rows.length} dòng, sẵn sàng.`);
      const res = await eng.run(`SELECT * FROM ${s.table}`);
      resultsLocal.show(res);
    } catch (err) {
      setStatus('');
      showError(err);
    }
  }

  /* --------------------------------------------------- run / submit ----- */

  function selectedSql() {
    const sel = cm.getSelection();
    return (sel && sel.trim() ? sel : cm.getValue()).trim();
  }

  async function run() {
    if (!current) return;
    const sql = selectedSql();
    if (!sql) return;
    clearError();
    runBtn.disabled = true;
    setStatus('Đang chạy…');
    try {
      if (current.kind === 'dml') {
        const eng = await getEngine();
        resultsLocal.show(await eng.run(sql));
      } else {
        if (inflight) inflight.abort();
        inflight = new AbortController();
        const res = await api.query(sql, 200, inflight.signal, datasetOf(current));
        resultsServer.show(res);
      }
      setStatus('');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setStatus('');
      showError(err);
    } finally {
      runBtn.disabled = false;
    }
  }

  async function submit() {
    if (!current) return;
    const ch = current;
    clearError();
    submitBtn.disabled = true;
    setStatus('Đang chấm…');
    try {
      let body;
      if (ch.kind === 'dml') {
        if (!sampleInfo) throw new Error('Bảng mẫu chưa sẵn sàng. Bấm "Nạp lại bảng mẫu" rồi thử lại.');
        body = { state: await (await getEngine()).state(sampleInfo.table) };
      } else {
        const sql = selectedSql();
        if (!sql) throw new Error('Viết câu SQL trước khi nộp.');
        body = { sql };
      }
      const v = await api.challengeSubmit(ch.id, body);
      if (current !== ch) return;
      showVerdict(v);
      if (v.passed) {
        const item = (catalogue.challenges || []).find((c) => c.id === ch.id);
        if (item) item.solved = true;
        current = { ...current, solved: true, takeaway: v.takeaway || current.takeaway };
        if (v.progress_saved !== false) {
          catalogue.my_points = v.domain_points;
          catalogue.my_solved = v.domain_solved;
        }
        renderScore();
        renderList();
        renderProblem();
      }
      setStatus('');
    } catch (err) {
      setStatus('');
      showError(err);
    } finally {
      submitBtn.disabled = false;
    }
  }

  function showVerdict(v) {
    verdictEl.hidden = false;
    verdictEl.className = 'ch-verdict ' + (v.passed ? 'is-pass' : 'is-fail');
    verdictEl.replaceChildren();
    if (v.passed) {
      verdictEl.appendChild(h('p', 'ch-verdict-head', 'Chính xác.'));
      verdictEl.appendChild(
        h('p', '', v.progress_saved === false
          ? 'Máy chủ chưa lưu được tiến độ lúc này, nên điểm chưa được cộng. Bài làm của bạn vẫn đúng.'
          : v.points_awarded
            ? `Bạn được cộng ${v.points_awarded} điểm. Tổng điểm lĩnh vực này: ${v.domain_points}.`
            : 'Bạn đã giải bài này trước đó, điểm không cộng thêm.')
      );
      if (v.takeaway) {
        verdictEl.appendChild(h('p', 'ch-verdict-sub', 'Điều rút ra'));
        verdictEl.appendChild(h('p', '', v.takeaway));
        const note = takeawayNote(current && current.domain);
        if (note) verdictEl.appendChild(note);
      }
      return;
    }
    verdictEl.appendChild(h('p', 'ch-verdict-head', 'Chưa đúng.'));
    const why = {
      columns: `Kết quả của bạn có ${v.your_cols} cột, đề bài cần ${v.expected_cols} cột. Xem lại phần "Kết quả cần trả về".`,
      order: 'Đủ dòng và đúng giá trị, nhưng sai thứ tự sắp xếp. Xem lại ORDER BY trong đề bài.',
      rows: `Bạn trả ${v.your_rows} dòng, đáp án có ${v.expected_rows} dòng; ${v.matched_rows} dòng của bạn khớp. Kiểm tra lại điều kiện lọc, cách nhóm và làm tròn.`,
    };
    verdictEl.appendChild(h('p', '', why[v.reason] || why.rows));
  }

  /* ------------------------------------------------------------ misc --- */

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function showError(err) {
    errEl.hidden = false;
    errEl.replaceChildren();
    const head = h('div', 'err-head');
    if (err && err.error_code) head.appendChild(h('span', 'err-code', err.error_code));
    errEl.appendChild(head);
    errEl.appendChild(h('pre', 'err-msg', (err && err.message) || String(err)));
    const hint = err && err.error_code ? errorHint(err.error_code) : '';
    if (hint) errEl.appendChild(h('p', 'err-hint', hint));
  }

  function clearError() {
    errEl.hidden = true;
    errEl.replaceChildren();
  }

  /* --- phong to khung lam bai ----------------------------------------------
   * Khung lam bai (o SQL, phan dinh, ket qua) chiem tron cua so: an danh sach,
   * de bai va thanh tieu de. Cung quy uoc voi che do phong to cua console: chi
   * la trang thai hien thi, khong luu; Esc hoac bam lai de thu nho. */
  const expandBtn = q('.ch-expand');
  const expandIcon = q('.ch-expand-icon');
  const ICON_EXPAND = 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5';
  const ICON_SHRINK = 'M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5';

  function setWorkMax(on) {
    root.classList.toggle('is-work-max', on);
    document.body.classList.toggle('ch-work-max', on);
    expandBtn.setAttribute('aria-pressed', String(on));
    expandBtn.setAttribute('aria-label', on ? 'Thu nhỏ khung làm bài' : 'Phóng to khung làm bài toàn màn hình');
    expandBtn.title = on ? 'Thu nhỏ (Esc)' : 'Phóng to toàn màn hình (Esc để thoát)';
    expandIcon.setAttribute('d', on ? ICON_SHRINK : ICON_EXPAND);
    // Vung chua doi kich thuoc: CodeMirror va bang ket qua chi do lai khi duoc bao.
    requestAnimationFrame(() => {
      cm.refresh();
      window.dispatchEvent(new Event('resize'));
    });
  }
  expandBtn.addEventListener('click', () => setWorkMax(!root.classList.contains('is-work-max')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('is-work-max')) setWorkMax(false);
  });

  /** Dang xuat: tien do, de dang mo, cau dang go deu la cua nguoi truoc. */
  function clear() {
    if (root.classList.contains('is-work-max')) setWorkMax(false);
    epoch += 1;
    catalogue = [];
    current = null;
    schema = null;
    sampleInfo = null;
    listEl.replaceChildren();
    body.hidden = true;
    placeholder.hidden = false;
    verdictEl.hidden = true;
    runBtn.disabled = true;
    submitBtn.disabled = true;
    reloadBtn.hidden = true;
    cm.setValue('');
    resultsServer.clear();
    clearError();
    erd.clear();
    setStatus('');
    q('.ch-my-points').textContent = '0';
    q('.ch-my-solved').textContent = '0';
  }

  return { init, clear, refresh: () => cm.refresh() };
}

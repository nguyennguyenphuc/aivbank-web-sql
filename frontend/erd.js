/* Tab "Sơ đồ ERD": bảng nào nối với bảng nào, qua cột nào.
 *
 * Nguồn tên, giống hệt mọi panel khác (API_CONTRACT.md §9):
 *   - bộ dữ liệu đang mở: bảng và cột lấy từ GET /schema (qua schemaPanel, không
 *     gọi lần hai), cạnh lấy từ GET /schema/relationships. Máy chủ đã lọc cả hai
 *     đầu; ở đây vẫn bỏ mọi cạnh nhắc tới một bảng không có trong /schema, để
 *     sơ đồ không bao giờ là nguồn tên thứ hai.
 *   - database game: GET /schema/game trả cả bảng, cột lẫn cạnh. Console không
 *     chạy truy vấn trên database này, nên ở đây là "Sao chép" chứ không "Chèn".
 *
 * Vẽ tay bằng SVG, không thư viện: frontend/ không có build step và không tải
 * gì từ CDN. Bố cục phân bậc: bảng được tham chiếu nằm bên trái, bảng giữ khoá
 * ngoại nằm bên phải, nên đọc từ trái sang phải là đi từ danh mục tới sự kiện.
 *
 * Chuyển động chỉ dùng transform/opacity, và chỉ khi người dùng kéo/zoom; không
 * có hiệu ứng tự chạy.
 */

import { api } from './api.js';
import { errorHint } from './errors.js';

const SVG = 'http://www.w3.org/2000/svg';
const NODE_W = 248;
const HEAD_H = 32;
const ROW_H = 20;
const PAD_Y = 6;
const GAP_X = 112;
const GAP_Y = 22;
const LANE_HEAD = 34;
const COL_MAX_H = 1500;
/** Số cột khoá hiện trong một bảng ở chế độ toàn cảnh, trước dòng "+n cột". */
const OVERVIEW_ROWS = 7;
/** Bề rộng ước lượng một ký tự mono 12px - đủ để cắt tên mà không đo DOM. */
const CH = 7.3;

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clip(text, chars) {
  return text.length > chars ? text.slice(0, Math.max(1, chars - 1)) + '…' : text;
}

/* ------------------------------------------------------------------ model -- */

/** Chuẩn hoá về một dạng: { tables, byName, edges }. */
function buildModel(tables, relationships) {
  const list = tables.map((t) => ({
    name: t.name,
    kind: t.kind || 'table',
    columns: (t.columns || []).map((c) => ({
      name: c.name,
      type: c.type,
      pk: Boolean(c.primary_key),
      nullable: c.nullable,
    })),
  }));
  const byName = new Map(list.map((t) => [t.name.toLowerCase(), t]));
  const edges = [];
  for (const r of relationships || []) {
    const from = byName.get(String(r.from_table).toLowerCase());
    const to = byName.get(String(r.to_table).toLowerCase());
    if (!from || !to) continue; // không có trong /schema -> không tồn tại ở đây
    edges.push({
      from: from.name,
      to: to.name,
      fromCols: r.from_columns || [],
      toCols: r.to_columns || [],
      inferred: Boolean(r.inferred),
    });
  }
  for (const t of list) {
    t.fkCols = new Set(
      edges.filter((e) => e.from === t.name).flatMap((e) => e.fromCols.map((c) => c.toLowerCase()))
    );
  }
  return { tables: list, byName, edges };
}

function neighbours(model, name) {
  const out = new Set([name]);
  for (const e of model.edges) {
    if (e.from === name) out.add(e.to);
    if (e.to === name) out.add(e.from);
  }
  return out;
}

/* ----------------------------------------------------------------- layout -- */

/**
 * Bậc của một bảng = số bước khoá ngoại dài nhất tới một bảng không tham chiếu
 * bảng nào. Bảng gốc bậc 0 ở bên trái. Vòng (hiếm) bị cắt bằng tập "đang thăm".
 * Bảng không có cạnh nào gom về một làn riêng ở cuối.
 */
function layout(model, names, { full, center = null, colMax = COL_MAX_H }) {
  const pick = new Set(names);
  const tables = model.tables.filter((t) => pick.has(t.name));
  const edges = model.edges.filter((e) => pick.has(e.from) && pick.has(e.to) && e.from !== e.to);
  const parents = new Map(tables.map((t) => [t.name, []]));
  const children = new Map(tables.map((t) => [t.name, []]));
  for (const e of edges) {
    parents.get(e.from).push(e.to);
    children.get(e.to).push(e.from);
  }

  const rank = new Map();
  const visiting = new Set();
  const rankOf = (n) => {
    if (rank.has(n)) return rank.get(n);
    if (visiting.has(n)) return 0;
    visiting.add(n);
    let r = 0;
    for (const p of parents.get(n)) r = Math.max(r, rankOf(p) + 1);
    visiting.delete(n);
    rank.set(n, r);
    return r;
  };
  tables.forEach((t) => rankOf(t.name));

  const lanes = [];
  if (center) {
    // Chế độ tập trung: ba cột đọc như một câu JOIN - bảng nó tham chiếu, chính
    // nó, bảng tham chiếu tới nó. Bảng vừa là cha vừa là con xếp bên trái.
    const up = new Set(edges.filter((e) => e.from === center).map((e) => e.to));
    const ref = tables.filter((t) => up.has(t.name) && t.name !== center);
    const mid = tables.filter((t) => t.name === center);
    const down = tables.filter((t) => t.name !== center && !up.has(t.name));
    if (ref.length) lanes.push({ label: 'Bảng nó tham chiếu', members: ref });
    lanes.push({ label: 'Bảng đang xem', members: mid });
    if (down.length) lanes.push({ label: 'Bảng tham chiếu tới nó', members: down });
  } else {
    const isolated = tables.filter((t) => !parents.get(t.name).length && !children.get(t.name).length);
    const linked = tables.filter((t) => !isolated.includes(t));
    const maxRank = Math.max(0, ...linked.map((t) => rank.get(t.name)));
    for (let r = 0; r <= maxRank; r++) {
      const members = linked.filter((t) => rank.get(t.name) === r);
      if (members.length) lanes.push({ label: r === 0 ? 'Bảng gốc' : `Bậc ${r}`, members });
    }
    if (isolated.length) lanes.push({ label: 'Không có quan hệ', members: isolated, fixed: true });
  }

  // Thứ tự trong làn: theo tên trước (gom tiền tố core_/ref_ cạnh nhau), rồi vài
  // lượt barycenter qua lại để giảm số cạnh cắt nhau.
  const order = new Map();
  for (const lane of lanes) {
    lane.members.sort((a, b) => a.name.localeCompare(b.name));
    lane.members.forEach((t, i) => order.set(t.name, i));
  }
  const bary = (n, side) => {
    const ns = side.get(n);
    if (!ns.length) return order.get(n);
    return ns.reduce((s, x) => s + order.get(x), 0) / ns.length;
  };
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 === 0 ? lanes : [...lanes].reverse();
    const side = pass % 2 === 0 ? parents : children;
    for (const lane of seq) {
      if (lane.fixed) continue;
      lane.members.sort((a, b) => bary(a.name, side) - bary(b.name, side));
      lane.members.forEach((t, i) => order.set(t.name, i));
    }
  }

  const rowsOf = (t) => {
    if (full) return t.columns;
    const keys = t.columns.filter((c) => c.pk || t.fkCols.has(c.name.toLowerCase()));
    return keys.slice(0, OVERVIEW_ROWS);
  };
  const heightOf = (t) => {
    const rows = rowsOf(t).length;
    const more = t.columns.length - rows > 0 ? 1 : 0;
    return HEAD_H + PAD_Y * 2 + (rows + more) * ROW_H;
  };

  // Làn quá dài thì gập thành nhiều cột con, để sơ đồ 77 bảng không thành một
  // dải dọc 6000px.
  const pos = new Map();
  const laneBoxes = [];
  let x = 0;
  for (const lane of lanes) {
    let y = LANE_HEAD;
    let colX = x;
    let laneW = NODE_W;
    for (const t of lane.members) {
      const hgt = heightOf(t);
      if (y > LANE_HEAD && y + hgt > colMax) {
        colX += NODE_W + GAP_X / 2;
        laneW += NODE_W + GAP_X / 2;
        y = LANE_HEAD;
      }
      pos.set(t.name, { x: colX, y, w: NODE_W, h: hgt, rows: rowsOf(t), table: t });
      y += hgt + GAP_Y;
    }
    laneBoxes.push({ label: lane.label, x, w: laneW });
    x += laneW + GAP_X;
  }
  const width = Math.max(NODE_W, x - GAP_X);
  const height = Math.max(LANE_HEAD + 40, ...[...pos.values()].map((p) => p.y + p.h));
  return { pos, edges, lanes: laneBoxes, width, height };
}

/** Chỉ để kiểm thử bố cục ngoài trình duyệt; giao diện không dùng. */
export const __erdInternals = { buildModel, layout, neighbours };

/* ----------------------------------------------------------------- panel --- */

export function createErdPanel({ root, getConsoleSchema, getConsoleLabel, onInsert }) {
  const q = (sel) => root.querySelector(sel);
  const canvas = q('.erd-canvas');
  const svg = q('.erd-svg');
  const statusEl = q('.erd-status');
  const detailEl = q('.erd-detail');
  const noteEl = q('.erd-note');
  const filterEl = q('.erd-filter');
  const srcConsole = q('[data-erd-source="console"]');
  const srcGame = q('[data-erd-source="game"]');
  const listEl = q('.erd-edge-list');

  let source = 'console';
  /** Kết quả đã tải, theo nguồn. Bị xoá khi đổi bộ dữ liệu hoặc đăng xuất. */
  const loaded = { console: null, game: null };
  let model = null;
  let focus = null; // tên bảng đang ở chế độ tập trung
  let selected = null;
  let view = { x: 24, y: 16, k: 1 };
  let drawn = null;
  let token = 0;

  srcConsole.addEventListener('click', () => setSource('console'));
  srcGame.addEventListener('click', () => setSource('game'));
  q('[data-erd-zoom="in"]').addEventListener('click', () => zoomBy(1.2));
  q('[data-erd-zoom="out"]').addEventListener('click', () => zoomBy(1 / 1.2));
  q('[data-erd-zoom="fit"]').addEventListener('click', fit);
  filterEl.addEventListener('input', applyFilter);
  filterEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const hit = matches()[0];
    if (hit) select(hit, { focusNode: true });
  });

  function setSource(next) {
    if (next === source) return;
    source = next;
    focus = null;
    selected = null;
    // Từ khoá của database kia không khớp bảng nào ở đây: giữ lại là làm mờ cả sơ đồ.
    filterEl.value = '';
    paintSource();
    show();
  }

  function paintSource() {
    srcConsole.setAttribute('aria-pressed', String(source === 'console'));
    srcGame.setAttribute('aria-pressed', String(source === 'game'));
    srcConsole.textContent = getConsoleLabel() || 'Bộ dữ liệu đang mở';
  }

  function setGameAvailable(on) {
    srcGame.hidden = !on;
    if (!on && source === 'game') setSource('console');
  }

  /** Gọi mỗi lần tab ERD được mở. Chỉ tải khi chưa có. */
  async function show() {
    paintSource();
    if (loaded[source]) return render();
    const my = ++token;
    setState('loading');
    try {
      let data;
      if (source === 'game') {
        const g = await api.gameSchema();
        data = buildModel(g.tables || [], g.relationships || []);
        data.schemaName = g.schema_name;
      } else {
        const schema = await getConsoleSchema();
        if (!schema) throw { message: 'Chưa tải được danh sách bảng.' };
        const rel = await api.relationships();
        data = buildModel(schema.tables, rel.relationships || []);
      }
      if (my !== token) return;
      loaded[source] = data;
      render();
    } catch (err) {
      if (my !== token) return;
      setState('error', err);
    }
  }

  function setState(state, err) {
    root.dataset.state = state;
    svg.replaceChildren();
    detailEl.replaceChildren();
    listEl.replaceChildren();
    if (state === 'loading') {
      statusEl.textContent = 'Đang tải sơ đồ…';
      canvas.classList.add('is-loading');
      return;
    }
    canvas.classList.remove('is-loading');
    if (state === 'error') {
      statusEl.textContent = '';
      const box = h('div', 'erd-error');
      box.setAttribute('role', 'alert');
      const msg = source === 'game' && err && err.error_code === 'E_GAME_UNAVAILABLE'
        ? 'Database game chưa sẵn sàng trên máy chủ này.'
        : (err && err.message) || 'Không tải được sơ đồ.';
      box.appendChild(h('p', 'erd-error-text', `${msg} ${errorHint(err && err.error_code)}`.trim()));
      const retry = h('button', 'btn btn-ghost btn-sm', 'Thử lại');
      retry.type = 'button';
      retry.addEventListener('click', show);
      box.appendChild(retry);
      detailEl.appendChild(box);
    }
  }

  function render() {
    model = loaded[source];
    root.dataset.state = 'full';
    canvas.classList.remove('is-loading');
    noteEl.hidden = source !== 'game';
    if (source === 'game') {
      noteEl.textContent =
        `Schema ${model.schemaName || 'jelly_analytics'} của database game. Console không chạy ` +
        'truy vấn trên database này: dùng psql hoặc Power BI qua cổng 5433. ' +
        (model.edges.some((e) => e.inferred)
          ? 'Database không khai báo khoá ngoại, nên đường nét đứt là quan hệ suy ra từ tên cột.'
          : '');
    }
    if (!model.tables.length) {
      statusEl.textContent = '';
      svg.replaceChildren();
      detailEl.replaceChildren(h('p', 'empty', 'Bộ dữ liệu này chưa có bảng nào bạn xem được.'));
      listEl.replaceChildren();
      return;
    }
    const names = focus ? [...neighbours(model, focus)] : model.tables.map((t) => t.name);
    // Cột cao tối đa theo tỉ lệ khung: khung kết quả thường thấp và rộng, nên
    // sơ đồ dàn ngang thì "vừa khung" không phải thu chữ xuống quá nhỏ.
    const box = canvas.getBoundingClientRect();
    const colMax = box.width && box.height
      ? Math.min(COL_MAX_H, Math.max(560, (box.height / box.width) * 2600))
      : COL_MAX_H;
    drawn = layout(model, names, { full: Boolean(focus), center: focus, colMax });
    draw();
    renderDetail();
    renderEdgeList();
    statusEl.textContent = focus
      ? `${names.length} bảng quanh ${focus}`
      : `${model.tables.length} bảng, ${model.edges.length} quan hệ`;
    fit();
    applyFilter();
  }

  /* ---------------------------------------------------------------- draw -- */

  function draw() {
    svg.replaceChildren();
    const defs = el('defs', {}, svg);
    // Crow's foot: "nhiều" ở đầu bảng giữ khoá ngoại, "một" ở đầu bảng được tham chiếu.
    const many = el('marker', {
      id: 'erd-many', viewBox: '0 0 14 14', refX: '1', refY: '7',
      markerWidth: '14', markerHeight: '14', orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse',
    }, defs);
    el('path', { d: 'M1 7 L13 1 M1 7 L13 7 M1 7 L13 13', class: 'erd-mark' }, many);
    const one = el('marker', {
      id: 'erd-one', viewBox: '0 0 14 14', refX: '13', refY: '7',
      markerWidth: '14', markerHeight: '14', orient: 'auto', markerUnits: 'userSpaceOnUse',
    }, defs);
    el('path', { d: 'M7 1 L7 13 M11 1 L11 13', class: 'erd-mark' }, one);

    const vp = el('g', { class: 'erd-viewport' }, svg);
    for (const lane of drawn.lanes) {
      const t = el('text', { x: lane.x, y: 18, class: 'erd-lane' }, vp);
      t.textContent = lane.label;
    }
    const edgeLayer = el('g', { class: 'erd-edges' }, vp);
    const nodeLayer = el('g', { class: 'erd-nodes' }, vp);

    for (const e of drawn.edges) {
      const a = drawn.pos.get(e.from);
      const b = drawn.pos.get(e.to);
      const ay = rowY(a, e.fromCols[0]);
      const by = rowY(b, e.toCols[0]);
      const leftToRight = a.x > b.x;
      const x1 = leftToRight ? a.x : a.x + a.w;
      const x2 = leftToRight ? b.x + b.w : b.x;
      const dx = Math.max(48, Math.abs(x1 - x2) / 2);
      const s = leftToRight ? -1 : 1;
      const d = `M${x1} ${ay} C${x1 + s * dx} ${ay} ${x2 - s * dx} ${by} ${x2} ${by}`;
      const path = el('path', {
        d,
        class: 'erd-edge' + (e.inferred ? ' is-inferred' : ''),
        'marker-start': 'url(#erd-many)',
        'marker-end': 'url(#erd-one)',
        'data-from': e.from,
        'data-to': e.to,
      }, edgeLayer);
      const title = el('title', {}, path);
      title.textContent = `${e.from}.${e.fromCols.join(', ')} → ${e.to}.${e.toCols.join(', ')}` +
        (e.inferred ? ' (suy luận)' : '');
    }

    for (const p of drawn.pos.values()) drawNode(nodeLayer, p);
    applyView();
    // `has-light` sống trên chính <svg>, không bị replaceChildren() xoá: áp lại
    // cho các nút vừa vẽ, nếu không cả sơ đồ mờ đi sau khi vẽ lại.
    light(null);
  }

  function rowY(p, col) {
    const i = p.rows.findIndex((c) => c.name.toLowerCase() === String(col || '').toLowerCase());
    if (i < 0) return p.y + HEAD_H / 2;
    return p.y + HEAD_H + PAD_Y + i * ROW_H + ROW_H / 2;
  }

  function drawNode(layer, p) {
    const t = p.table;
    const g = el('g', {
      class: 'erd-node' + (t.kind === 'view' ? ' is-view' : '') + (t.name === selected ? ' is-selected' : ''),
      transform: `translate(${p.x} ${p.y})`,
      tabindex: '0',
      role: 'button',
      'data-table': t.name,
      'aria-label': `Bảng ${t.name}, ${t.columns.length} cột. Bấm để xem cột và cách JOIN.`,
    }, layer);
    el('rect', { class: 'erd-box', width: p.w, height: p.h, rx: 8 }, g);
    el('rect', { class: 'erd-head', width: p.w, height: HEAD_H, rx: 8 }, g);
    el('rect', { class: 'erd-head', y: HEAD_H - 8, width: p.w, height: 8 }, g);
    const name = el('text', { class: 'erd-name', x: 12, y: HEAD_H / 2 + 4 }, g);
    name.textContent = clip(t.name, Math.floor((p.w - 24 - (t.kind === 'view' ? 40 : 0)) / CH));
    if (t.kind === 'view') {
      const v = el('text', { class: 'erd-kind', x: p.w - 12, y: HEAD_H / 2 + 4, 'text-anchor': 'end' }, g);
      v.textContent = 'view';
    }
    p.rows.forEach((c, i) => {
      const y = HEAD_H + PAD_Y + i * ROW_H + ROW_H / 2 + 4;
      const isFk = t.fkCols.has(c.name.toLowerCase());
      const key = c.pk ? 'PK' : isFk ? 'FK' : '';
      if (key) {
        const k = el('text', { class: 'erd-key' + (c.pk ? ' is-pk' : ''), x: 12, y }, g);
        k.textContent = key;
      }
      const typeChars = Math.min(12, (c.type || '').length);
      const n = el('text', { class: 'erd-col', x: 38, y }, g);
      n.textContent = clip(c.name, Math.floor((p.w - 38 - 12 - typeChars * 6.2 - 8) / CH));
      const ty = el('text', { class: 'erd-type', x: p.w - 12, y, 'text-anchor': 'end' }, g);
      ty.textContent = clip(c.type || '', 12);
    });
    const more = t.columns.length - p.rows.length;
    if (more > 0) {
      const y = HEAD_H + PAD_Y + p.rows.length * ROW_H + ROW_H / 2 + 4;
      const m = el('text', { class: 'erd-more', x: 38, y }, g);
      m.textContent = `và ${more} cột khác`;
    }

    g.addEventListener('pointerenter', () => light(t.name));
    g.addEventListener('pointerleave', () => light(null));
    g.addEventListener('focus', () => light(t.name));
    g.addEventListener('blur', () => light(null));
    g.addEventListener('click', (ev) => {
      if (moved) return;
      ev.stopPropagation();
      select(t.name);
    });
    g.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      select(t.name);
    });
  }

  /* ---------------------------------------------------------- highlight -- */

  function light(name) {
    const target = name || selected;
    svg.classList.toggle('has-light', Boolean(target));
    if (!target) {
      svg.querySelectorAll('.is-lit').forEach((n) => n.classList.remove('is-lit'));
      return;
    }
    const near = neighbours(model, target);
    svg.querySelectorAll('.erd-node').forEach((n) => n.classList.toggle('is-lit', near.has(n.dataset.table)));
    svg.querySelectorAll('.erd-edge').forEach((p) =>
      p.classList.toggle('is-lit', p.dataset.from === target || p.dataset.to === target));
  }

  function matches() {
    const q2 = filterEl.value.trim().toLowerCase();
    if (!q2 || !model) return [];
    return model.tables.filter((t) => t.name.toLowerCase().includes(q2)).map((t) => t.name);
  }

  function applyFilter() {
    if (!drawn) return;
    const hits = new Set(matches());
    const on = Boolean(filterEl.value.trim());
    svg.classList.toggle('has-filter', on);
    svg.querySelectorAll('.erd-node').forEach((n) => n.classList.toggle('is-hit', hits.has(n.dataset.table)));
  }

  function select(name, { focusNode = false } = {}) {
    selected = name;
    svg.querySelectorAll('.erd-node').forEach((n) => n.classList.toggle('is-selected', n.dataset.table === name));
    light(null);
    renderDetail();
    const p = drawn && drawn.pos.get(name);
    if (p) centerOn(p);
    if (focusNode) {
      const node = svg.querySelector(`.erd-node[data-table="${CSS.escape(name)}"]`);
      if (node) node.focus();
    }
  }

  /* -------------------------------------------------------------- detail -- */

  function joinText(e) {
    const on = e.fromCols.map((c, i) => `${e.from}.${c} = ${e.to}.${e.toCols[i]}`).join(' AND ');
    return { from: e.from, to: e.to, on };
  }

  function renderDetail() {
    detailEl.replaceChildren();
    if (!model) return;
    if (!selected) {
      const intro = h('div', 'erd-intro');
      intro.appendChild(h('h3', 'erd-detail-title', 'Đọc sơ đồ'));
      const ul = h('ul', 'erd-legend');
      const li = (cls, text) => {
        const item = h('li');
        item.appendChild(h('span', `erd-swatch ${cls}`));
        item.appendChild(h('span', '', text));
        ul.appendChild(item);
      };
      li('is-pk', 'PK: khoá chính, mỗi dòng một giá trị riêng');
      li('is-fk', 'FK: khoá ngoại, trỏ tới khoá chính của bảng bên trái');
      li('is-edge', 'Nét liền: quan hệ database khai báo');
      if (model.edges.some((e) => e.inferred)) li('is-inferred', 'Nét đứt: quan hệ suy ra từ tên cột');
      intro.appendChild(ul);
      intro.appendChild(h('p', 'muted', 'Bấm một bảng để xem đủ cột và câu JOIN tới các bảng nối với nó.'));
      if (!model.edges.length) {
        intro.appendChild(h('p', 'erd-warn', 'Bộ dữ liệu này không khai báo khoá ngoại nào, nên sơ đồ chỉ có các bảng rời.'));
      }
      detailEl.appendChild(intro);
      return;
    }

    const t = model.byName.get(selected.toLowerCase());
    if (!t) return;
    const head = h('div', 'erd-detail-head');
    head.appendChild(h('h3', 'erd-detail-title', t.name));
    const actions = h('div', 'erd-detail-actions');
    const focusBtn = h('button', 'btn btn-ghost btn-sm', focus === t.name ? 'Toàn bộ sơ đồ' : 'Chỉ bảng liên quan');
    focusBtn.type = 'button';
    focusBtn.addEventListener('click', () => {
      focus = focus === t.name ? null : t.name;
      render();
    });
    const close = h('button', 'btn btn-ghost btn-sm', 'Bỏ chọn');
    close.type = 'button';
    close.addEventListener('click', () => {
      selected = null;
      if (focus) {
        focus = null;
        render();
      } else {
        select(null);
      }
    });
    actions.append(focusBtn, close);
    head.appendChild(actions);
    detailEl.appendChild(head);

    const cols = h('ul', 'erd-cols');
    for (const c of t.columns) {
      const li = h('li', 'erd-col-row');
      const key = c.pk ? 'PK' : t.fkCols.has(c.name.toLowerCase()) ? 'FK' : '';
      li.appendChild(h('span', 'erd-col-key' + (c.pk ? ' is-pk' : ''), key));
      li.appendChild(h('code', 'erd-col-name', c.name));
      li.appendChild(h('span', 'erd-col-type', c.type || ''));
      cols.appendChild(li);
    }
    detailEl.appendChild(cols);

    const rel = model.edges.filter((e) => e.from === t.name || e.to === t.name);
    detailEl.appendChild(h('h4', 'erd-detail-sub', rel.length ? 'Cách JOIN' : 'Không có quan hệ nào'));
    const joins = h('ul', 'erd-joins');
    for (const e of rel) {
      const { from, to, on } = joinText(e);
      const other = e.from === t.name ? to : from;
      const sql = `JOIN ${other} ON ${on}`;
      const li = h('li', 'erd-join');
      li.appendChild(h('code', 'erd-join-sql', sql));
      if (e.inferred) li.appendChild(h('span', 'erd-join-note', 'suy luận'));
      const btn = h('button', 'btn btn-ghost btn-sm', source === 'game' ? 'Sao chép' : 'Chèn');
      btn.type = 'button';
      btn.setAttribute('aria-label', `${source === 'game' ? 'Sao chép' : 'Chèn vào editor'}: ${sql}`);
      btn.addEventListener('click', () => use(sql, btn));
      li.appendChild(btn);
      joins.appendChild(li);
    }
    detailEl.appendChild(joins);
  }

  async function use(sql, btn) {
    if (source === 'game') {
      try {
        await navigator.clipboard.writeText(sql);
        flash(btn, 'Đã chép');
      } catch (_) {
        flash(btn, 'Không chép được');
      }
      return;
    }
    onInsert(sql + '\n');
    flash(btn, 'Đã chèn');
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  /** Bản văn bản của toàn bộ sơ đồ, cho trình đọc màn hình và để in. */
  function renderEdgeList() {
    listEl.replaceChildren();
    if (!model.edges.length) return;
    const table = h('table', 'erd-table');
    const thead = h('thead');
    const tr = h('tr');
    ['Bảng', 'Cột', 'Tham chiếu tới', ''].forEach((t) => tr.appendChild(h('th', '', t)));
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = h('tbody');
    for (const e of model.edges) {
      const row = h('tr');
      row.appendChild(h('td', '', e.from));
      row.appendChild(h('td', '', e.fromCols.join(', ')));
      row.appendChild(h('td', '', `${e.to}.${e.toCols.join(', ')}`));
      row.appendChild(h('td', 'muted', e.inferred ? 'suy luận' : ''));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    listEl.appendChild(table);
  }

  /* ----------------------------------------------------------- pan / zoom -- */

  function applyView() {
    const vp = svg.querySelector('.erd-viewport');
    if (vp) vp.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  function fit() {
    if (!drawn) return;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const k = Math.min(1.1, Math.max(0.2, Math.min(
      (box.width - 48) / drawn.width,
      (box.height - 32) / drawn.height,
    )));
    view = {
      k,
      x: Math.max(24, (box.width - drawn.width * k) / 2),
      y: 16,
    };
    applyView();
  }

  function centerOn(p) {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    const k = Math.max(view.k, 0.7);
    view = { k, x: box.width / 2 - (p.x + p.w / 2) * k, y: box.height / 2 - (p.y + p.h / 2) * k };
    applyView();
  }

  function zoomBy(f, cx, cy) {
    const box = canvas.getBoundingClientRect();
    const px = cx ?? box.width / 2;
    const py = cy ?? box.height / 2;
    const k = Math.min(2.5, Math.max(0.15, view.k * f));
    view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    applyView();
  }

  let drag = null;
  let moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId };
    moved = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      canvas.setPointerCapture(drag.id);
      canvas.classList.add('is-panning');
    }
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove('is-panning');
    // `click` chạy SAU pointerup: giữ cờ một nhịp để cú kéo không thành cú chọn.
    setTimeout(() => { moved = false; }, 0);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    if (!drawn) return;
    e.preventDefault();
    const box = canvas.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - box.left, e.clientY - box.top);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.target !== canvas) return;
    const step = 60;
    const keys = {
      ArrowLeft: () => { view.x += step; },
      ArrowRight: () => { view.x -= step; },
      ArrowUp: () => { view.y += step; },
      ArrowDown: () => { view.y -= step; },
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
      applyView();
    } else if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === '0') fit();
  });
  // Bấm vào nền (không trúng bảng) là bỏ chọn.
  svg.addEventListener('click', (e) => {
    if (moved || e.target.closest('.erd-node') || !selected) return;
    selected = null;
    select(null);
  });

  /* ------------------------------------------------------------ lifecycle -- */

  /** Đổi bộ dữ liệu: sơ đồ của bộ cũ phải đi, cùng lý do với schemaPanel.clear(). */
  function resetConsole() {
    token++;
    loaded.console = null;
    if (source === 'console') {
      filterEl.value = '';
      wipe();
    }
  }

  /** Đăng xuất: không gì của phiên trước được ở lại. */
  function clear() {
    token++;
    loaded.console = null;
    loaded.game = null;
    source = 'console';
    filterEl.value = '';
    wipe();
  }

  function wipe() {
    model = null;
    drawn = null;
    focus = null;
    selected = null;
    svg.replaceChildren();
    detailEl.replaceChildren();
    listEl.replaceChildren();
    statusEl.textContent = '';
    noteEl.hidden = true;
    root.dataset.state = 'empty';
  }

  return { show, clear, resetConsole, setGameAvailable, refit: fit };
}

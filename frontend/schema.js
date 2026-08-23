/* Schema explorer sidebar.
 *
 * Every name rendered here comes from GET /schema (list + columns for
 * autocomplete) or GET /schema/tables/{name} (row counts on demand). Nothing is
 * cached across page loads — no localStorage, no service worker — so that a
 * change on the backend takes effect on the next reload rather than lingering
 * in a stale client copy (API_CONTRACT.md §9.1).
 */

import { api } from './api.js';
import { errorHint } from './errors.js';

export function createSchemaPanel({ listEl, countEl, filterEl, refreshBtn, onInsert, onError }) {
  /** @type {{tables: Array, byName: Map}|null} */
  let schema = null;
  const expanded = new Set();
  const rowCounts = new Map();

  filterEl.addEventListener('input', render);
  refreshBtn.addEventListener('click', () => load(true));

  async function load(isRefresh = false) {
    // A schema is session/role-specific. Drop every previous reference before
    // asking the API again so autocomplete cannot serve stale names while the
    // new request is in flight.
    schema = null;
    expanded.clear();
    rowCounts.clear();
    countEl.textContent = '';
    // `empty-loading` is presentation only: it swaps the empty-state glyph for
    // a "waiting" one. The text and the control flow are unchanged.
    listEl.innerHTML = '<p class="empty empty-loading">Đang tải danh sách bảng…</p>';
    try {
      const data = await api.schema();
      const tables = (data.tables || []).map((t) => ({
        name: t.name,
        columns: t.columns || [],
      }));
      tables.sort((a, b) => a.name.localeCompare(b.name));
      schema = { tables, byName: new Map(tables.map((t) => [t.name.toLowerCase(), t])) };
      countEl.textContent = `(${data.table_count ?? tables.length})`;
      render();
    } catch (err) {
      schema = null;
      countEl.textContent = '';
      listEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty empty-error';
      p.textContent = `${err.message || 'Không tải được danh sách bảng.'} ${errorHint(err.error_code)}`;
      listEl.appendChild(p);
      if (onError) onError(err);
    }
    return schema;
  }

  function matches(table, q) {
    if (!q) return { table: true, cols: null };
    const inName = table.name.toLowerCase().includes(q);
    const cols = table.columns.filter((c) => c.name.toLowerCase().includes(q));
    return { table: inName || cols.length > 0, cols: inName ? null : cols };
  }

  function render() {
    if (!schema) return;
    const q = filterEl.value.trim().toLowerCase();
    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (const table of schema.tables) {
      const m = matches(table, q);
      if (!m.table) continue;
      shown++;

      const item = document.createElement('div');
      item.className = 'tbl';

      const head = document.createElement('button');
      head.className = 'tbl-head';
      head.type = 'button';
      head.setAttribute('aria-expanded', String(expanded.has(table.name)));
      head.innerHTML =
        '<span class="caret"></span>' +
        `<span class="tbl-name"></span>` +
        `<span class="tbl-cols"></span>`;
      head.querySelector('.tbl-name').textContent = table.name;
      // A long name is ellipsised in the sidebar, so the full one has to stay
      // reachable. Still the API's name, still cleared by clear() with the rest
      // of the list — this adds a tooltip, not a second source of names.
      head.title = table.name;
      const rc = rowCounts.get(table.name);
      head.querySelector('.tbl-cols').textContent =
        rc === undefined ? `${table.columns.length} cột` : `${table.columns.length} cột · ${rc.toLocaleString('en-US')} dòng`;
      head.addEventListener('click', () => toggle(table));
      item.appendChild(head);

      const use = document.createElement('button');
      use.className = 'tbl-insert';
      use.type = 'button';
      use.title = 'Chèn tên bảng vào ô soạn thảo';
      use.setAttribute('aria-label', `Chèn bảng ${table.name} vào trình soạn thảo`);
      use.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v13m0 0-5-5m5 5 5-5M5 20h14" /></svg>';
      use.addEventListener('click', (e) => {
        e.stopPropagation();
        onInsert(table.name);
      });
      item.appendChild(use);

      if (expanded.has(table.name) || (q && m.cols && m.cols.length)) {
        const cols = document.createElement('ul');
        cols.className = 'col-list';
        const source = expanded.has(table.name) ? table.columns : m.cols;
        for (const c of source) {
          const li = document.createElement('li');
          li.className = 'col' + (c.primary_key ? ' is-pk' : '');
          const nm = document.createElement('span');
          nm.className = 'col-name';
          nm.textContent = c.name;
          const ty = document.createElement('span');
          ty.className = 'col-type';
          ty.textContent = c.type;
          li.appendChild(nm);
          if (c.primary_key) {
            const pk = document.createElement('span');
            pk.className = 'tag tag-pk';
            pk.textContent = 'PK';
            li.appendChild(pk);
          }
          if (c.nullable === false) {
            const nn = document.createElement('span');
            nn.className = 'tag';
            nn.textContent = 'NOT NULL';
            li.appendChild(nn);
          }
          li.appendChild(ty);
          li.title = 'Bấm để chèn tên cột';
          li.addEventListener('click', () => onInsert(c.name));
          li.setAttribute('role', 'button');
          li.tabIndex = 0;
          li.setAttribute('aria-label', `Chèn cột ${c.name} vào trình soạn thảo`);
          li.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onInsert(c.name);
          });
          cols.appendChild(li);
        }
        item.appendChild(cols);
      }

      frag.appendChild(item);
    }

    if (!shown) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Không có bảng nào khớp với từ khoá lọc.';
      frag.appendChild(p);
    }
    listEl.appendChild(frag);
  }

  async function toggle(table) {
    if (expanded.has(table.name)) expanded.delete(table.name);
    else {
      expanded.add(table.name);
      if (!rowCounts.has(table.name)) {
        // Fetch the row count lazily. A failure here is non-fatal: the column
        // list from GET /schema is already correct, we simply show no count.
        try {
          const d = await api.table(table.name, true);
          if (typeof d.row_count === 'number') rowCounts.set(table.name, d.row_count);
        } catch (_) {
          /* keep the panel usable; the error surfaces when the student queries */
        }
      }
    }
    render();
  }

  /**
   * Forget every name we were shown.
   *
   * Called on sign-out and whenever the session is lost. The table list is the
   * one part of this UI that is permission-dependent, so it must not linger in
   * the DOM, in `schema` (which feeds autocomplete) or in `rowCounts` for the
   * next person at this keyboard.
   */
  function clear() {
    schema = null;
    expanded.clear();
    rowCounts.clear();
    filterEl.value = '';
    countEl.textContent = '';
    listEl.innerHTML = '';
  }

  return {
    load,
    clear,
    /** Live reference handed to the editor so autocomplete always sees the current schema. */
    ref: {
      get value() {
        return schema;
      },
    },
  };
}

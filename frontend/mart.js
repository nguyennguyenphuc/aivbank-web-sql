/* Role-aware data-mart browser.
 *
 * Mart and column names only come from the authenticated API. Nothing in this
 * file names a database object, so a student cannot discover an instructor-only
 * object by downloading the frontend source.
 */

import { api } from './api.js';
import { formatCell, shortType } from './format.js';

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

export function createMartPanel({ statusEl, selectEl, searchEl, refreshBtn, gridEl, summaryEl }) {
  let tableInfo = null;
  let data = null;
  let generation = 0;

  searchEl.addEventListener('input', render);
  selectEl.addEventListener('change', () => loadSelected(generation));
  refreshBtn.addEventListener('click', () => loadSelected(generation));

  /** Nap danh sach mart cua bo du lieu dang chon.
   *  @returns {Promise<number>} so mart vai tro nay duoc xem. Nguoi goi dung no
   *  de an han tab khi bo du lieu khong co mart nao - Supply Chain la mot vi du:
   *  20 bang, khong bang nao tien to `mart_`. Tra 0 khi loi, de mot API hong
   *  khong bao gio bien thanh mot tab hua hen thu khong co. */
  async function load() {
    const current = ++generation;
    tableInfo = null;
    data = null;
    selectEl.replaceChildren();
    selectEl.disabled = true;
    searchEl.value = '';
    searchEl.disabled = true;
    refreshBtn.disabled = true;
    statusEl.textContent = 'Đang tải';
    summaryEl.textContent = '';
    showEmpty('Đang tải danh sách data mart…', 'empty empty-loading');

    try {
      const response = await api.marts(true);
      if (current !== generation) return 0;
      const marts = Array.isArray(response.marts) ? response.marts : [];
      const martCount = marts.length;
      for (const mart of marts) {
        if (!mart || typeof mart.name !== 'string') continue;
        const option = document.createElement('option');
        option.value = mart.name;
        option.textContent = mart.row_count == null
          ? mart.name
          : `${mart.name} · ${Number(mart.row_count).toLocaleString('vi-VN')} dòng`;
        selectEl.appendChild(option);
      }
      if (!selectEl.options.length) {
        statusEl.textContent = 'Không có dữ liệu';
        summaryEl.textContent = 'Phiên hiện tại không có data mart được phép xem.';
        showEmpty('Không có data mart khả dụng trong phiên này.');
        return martCount;
      }
      selectEl.disabled = false;
      refreshBtn.disabled = false;
      await loadSelected(current);
      return martCount;
    } catch (err) {
      if (current !== generation) return 0;
      statusEl.textContent = 'Không tải được';
      summaryEl.textContent = err.message || 'Không đọc được danh sách data mart.';
      showEmpty('Data mart hiện chưa sẵn sàng.', 'empty empty-error');
      return 0;
    }
  }

  async function loadSelected(current) {
    const name = selectEl.value;
    if (!name || current !== generation) return;
    data = null;
    searchEl.value = '';
    searchEl.disabled = true;
    refreshBtn.disabled = true;
    statusEl.textContent = 'Đang tải';
    summaryEl.textContent = '';
    showEmpty('Đang tải dữ liệu data mart…', 'empty empty-loading');

    try {
      tableInfo = await api.mart(name, true);
      if (current !== generation || selectEl.value !== name) return;
      const visibleColumns = Array.isArray(tableInfo.columns) ? tableInfo.columns : [];
      if (!visibleColumns.length) {
        statusEl.textContent = 'Không có cột';
        showEmpty('Data mart này không có cột được phép xem.');
        return;
      }
      const projection = visibleColumns.map((column) => quote(column.name)).join(', ');
      data = await api.query(`SELECT ${projection} FROM ${quote(tableInfo.name)}`);
      if (current !== generation || selectEl.value !== name) return;
      statusEl.textContent = `${Number(data.row_count || 0).toLocaleString('vi-VN')} dòng`;
      searchEl.disabled = false;
      refreshBtn.disabled = false;
      render();
    } catch (err) {
      if (current !== generation) return;
      statusEl.textContent = 'Không tải được';
      summaryEl.textContent = err.message || 'Không đọc được data mart.';
      refreshBtn.disabled = false;
      showEmpty('Data mart hiện chưa sẵn sàng hoặc không thể đọc trong phiên này.', 'empty empty-error');
    }
  }

  function render() {
    if (!data) return;
    const needle = searchEl.value.trim().toLowerCase();
    const rows = data.rows.filter(
      (row) => !needle || row.some((value) => String(value ?? '').toLowerCase().includes(needle))
    );
    summaryEl.textContent =
      `${rows.length.toLocaleString('vi-VN')} / ${data.rows.length.toLocaleString('vi-VN')} dòng`;
    gridEl.replaceChildren();
    if (!rows.length) {
      showEmpty('Không có dòng nào khớp từ khoá.');
      return;
    }

    const table = document.createElement('table');
    table.className = 'grid mart-grid';
    const head = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'rownum';
    corner.textContent = '#';
    head.appendChild(corner);
    data.columns.forEach((name, index) => {
      const th = document.createElement('th');
      const label = document.createElement('span');
      label.className = 'col-h-name';
      label.textContent = name;
      const type = document.createElement('span');
      type.className = 'col-h-type';
      type.textContent = shortType(data.column_types[index]);
      th.append(label, type);
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const body = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const number = document.createElement('td');
      number.className = 'rownum';
      number.textContent = String(rowIndex + 1);
      tr.appendChild(number);
      row.forEach((value, columnIndex) => {
        const td = document.createElement('td');
        const cell = formatCell(value, data.column_types[columnIndex]);
        td.className = cell.cls;
        td.textContent = cell.text;
        td.title = cell.exact || cell.text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    gridEl.appendChild(table);
  }

  function showEmpty(message, className = 'empty') {
    const empty = document.createElement('p');
    empty.className = className;
    empty.textContent = message;
    gridEl.replaceChildren(empty);
  }

  function clear() {
    generation += 1;
    tableInfo = null;
    data = null;
    selectEl.replaceChildren();
    selectEl.disabled = true;
    searchEl.value = '';
    searchEl.disabled = true;
    statusEl.textContent = '';
    summaryEl.textContent = '';
    refreshBtn.disabled = true;
    showEmpty('Đăng nhập để xem data mart.');
  }

  return { load, clear };
}

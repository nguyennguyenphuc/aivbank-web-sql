/* Result grid + run detail panel. */

import { formatCell, shortType, toCsv } from './format.js';

/**
 * @param source  'server' (the console, run by PostgreSQL) or 'local' (the
 *   sandbox, run by DuckDB-WASM in this browser). It only changes wording, but
 *   the wording matters: telling a student the server timed a query that never
 *   left their laptop is a lie, and it is the exact lie the sandbox exists to
 *   avoid. Panels are constructed once per area, so this is a creation option.
 * @param detailEl  Optional. The sandbox has no run-detail tab.
 * @param filename  Base name offered by the CSV download button.
 */
export function createResultsPanel({
  gridWrap,
  metaEl,
  truncatedEl,
  detailEl = null,
  source = 'server',
  filename = 'ket-qua',
}) {
  let last = null;
  let group = true;
  const local = source === 'local';
  const byWhom = local ? 'trên máy bạn' : 'máy chủ';

  function clear() {
    gridWrap.innerHTML = '<p class="empty">Chưa có kết quả. Gõ một câu SELECT rồi nhấn Chạy.</p>';
    // Emptied, not just hidden: leaving the previous run's numbers in the DOM is
    // how a "stale result" bug reappears the next time someone tweaks the CSS.
    metaEl.innerHTML = '';
    metaEl.hidden = true;
    truncatedEl.textContent = '';
    truncatedEl.className = 'banner banner-info';
    truncatedEl.hidden = true;
    last = null;
  }

  function show(res) {
    last = res;
    renderMeta(res);
    renderGrid(res);
    renderDetail(res);
  }

  function renderMeta(res) {
    metaEl.hidden = false;
    metaEl.innerHTML = '';

    const stat = (label, value, cls = '') => {
      const s = document.createElement('span');
      s.className = 'stat ' + cls;
      s.innerHTML = '<b></b><i></i>';
      s.querySelector('b').textContent = value;
      s.querySelector('i').textContent = label;
      return s;
    };

    metaEl.appendChild(stat('dòng', res.row_count.toLocaleString('en-US')));
    metaEl.appendChild(stat('cột', String(res.columns.length)));
    metaEl.appendChild(stat(`ms (${byWhom})`, formatMs(res.elapsed_ms)));

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    metaEl.appendChild(spacer);

    const groupLbl = document.createElement('label');
    groupLbl.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = group;
    cb.addEventListener('change', () => {
      group = cb.checked;
      if (last) renderGrid(last);
    });
    groupLbl.appendChild(cb);
    groupLbl.appendChild(document.createTextNode('Nhóm hàng nghìn'));
    groupLbl.title =
      'Chỉ ảnh hưởng cách hiển thị. Giá trị gốc luôn giữ nguyên (di chuột lên ô để xem) và bản sao chép CSV luôn dùng giá trị gốc.';
    metaEl.appendChild(groupLbl);

    const csvBtn = document.createElement('button');
    csvBtn.className = 'btn btn-ghost btn-sm';
    csvBtn.textContent = 'Sao chép CSV';
    csvBtn.addEventListener('click', async () => {
      const csv = toCsv(res.columns, res.rows, res.column_types);
      try {
        await navigator.clipboard.writeText(csv);
        csvBtn.textContent = 'Đã sao chép';
      } catch (_) {
        csvBtn.textContent = 'Không sao chép được';
      }
      setTimeout(() => (csvBtn.textContent = 'Sao chép CSV'), 1600);
    });
    metaEl.appendChild(csvBtn);

    // Download, not just clipboard: a result too big to paste is exactly the
    // one worth keeping. It writes `_allRows` when present (the sandbox keeps
    // every row it fetched, not only the ones painted into the grid), so the
    // file can be larger than what is on screen -- and says so when it is.
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-ghost btn-sm';
    dlBtn.textContent = 'Tải CSV';
    const rowsForFile = res._allRows || res.rows;
    if (rowsForFile.length > res.rows.length) {
      dlBtn.title =
        `Tệp tải về chứa đủ ${rowsForFile.length.toLocaleString('en-US')} dòng, ` +
        `nhiều hơn ${res.rows.length.toLocaleString('en-US')} dòng đang hiển thị.`;
    }
    dlBtn.addEventListener('click', () => {
      const csv = toCsv(res.columns, rowsForFile, res.column_types);
      // BOM so Excel on Windows opens Vietnamese text without mojibake.
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick, not immediately: Safari has not started the
      // download yet when click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      dlBtn.textContent = 'Đã tải';
      setTimeout(() => (dlBtn.textContent = 'Tải CSV'), 1600);
    });
    metaEl.appendChild(dlBtn);

    // Rule §9.5: a capped result must never look like a complete one.
    //
    // The inverse matters just as much. Hiding the signal when nothing was cut
    // is silence, and silence is ambiguous: the reader cannot tell "you have
    // everything" apart from "the notice failed to render". So both cases are
    // stated out loud — but not at the same size.
    //
    // The two messages are not symmetric. "Your result was cut" changes what
    // the student may conclude from the numbers on screen, so it keeps the
    // full-width banner and its full sentence. "Nothing was cut" only needs to
    // be findable, and a banner costs ~34px of grid on a 13" laptop — which is
    // more than a row of data. It rides in the meta row as a chip instead.
    if (res.truncated) {
      truncatedEl.hidden = false;
      truncatedEl.className = 'banner banner-info banner-cut';
      truncatedEl.textContent =
        `Kết quả đã bị cắt bớt ở ${res.row_count.toLocaleString('en-US')} dòng ` +
        `(giới hạn ${Number(res.row_limit).toLocaleString('en-US')} dòng, hoặc do phản hồi quá lớn). ` +
        'Đây KHÔNG phải toàn bộ dữ liệu — hãy thêm WHERE, GROUP BY hoặc dùng COUNT(*) để xem con số đầy đủ.';
    } else {
      truncatedEl.hidden = true;
      truncatedEl.textContent = '';
      truncatedEl.className = 'banner banner-info';

      const full = document.createElement('span');
      full.className = 'tag tag-full';
      full.textContent = `Đầy đủ ${res.row_count.toLocaleString('en-US')} dòng`;
      full.title =
        `${local ? 'Truy vấn' : 'Máy chủ'} trả về đủ ${res.row_count.toLocaleString('en-US')} dòng, ` +
        'không dòng nào bị cắt. Cuộn trong bảng để xem hết.';
      metaEl.insertBefore(full, spacer);
    }
  }

  function renderGrid(res) {
    gridWrap.innerHTML = '';

    if (!res.columns.length) {
      gridWrap.innerHTML = '<p class="empty">Truy vấn chạy xong nhưng không trả về cột nào.</p>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'grid';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'rownum';
    corner.textContent = '#';
    hr.appendChild(corner);

    res.columns.forEach((name, i) => {
      const th = document.createElement('th');
      const n = document.createElement('span');
      n.className = 'col-h-name';
      n.textContent = name;
      const t = document.createElement('span');
      t.className = 'col-h-type';
      t.textContent = shortType(res.column_types[i]);
      th.appendChild(n);
      th.appendChild(t);
      th.title = `${name} — ${res.column_types[i]}`;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const frag = document.createDocumentFragment();

    res.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      const num = document.createElement('td');
      num.className = 'rownum';
      num.textContent = String(r + 1);
      tr.appendChild(num);

      row.forEach((cell, i) => {
        const td = document.createElement('td');
        const f = formatCell(cell, res.column_types[i], { group });
        td.className = f.cls + (f.warn ? ' v-warn' : '');
        td.textContent = f.text;
        if (f.cls === 'v-num' && f.text !== f.exact) td.title = f.exact;
        if (f.warn) td.title = 'Số nguyên vượt độ chính xác an toàn của trình duyệt — hãy kiểm tra lại bằng CAST(... AS VARCHAR).';
        if (f.cls !== 'v-null' && f.text.length > 60) td.title = f.exact;
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    table.appendChild(tbody);
    gridWrap.appendChild(table);

    if (!res.rows.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Truy vấn hợp lệ nhưng không có dòng nào khớp điều kiện.';
      gridWrap.appendChild(p);
    }
  }

  function renderDetail(res) {
    if (!detailEl) return; // the sandbox panel has no run-detail tab
    detailEl.innerHTML = '';

    const add = (label, node) => {
      const d = document.createElement('div');
      d.className = 'detail-row';
      const l = document.createElement('div');
      l.className = 'detail-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'detail-value';
      v.appendChild(node);
      d.appendChild(l);
      d.appendChild(v);
      detailEl.appendChild(d);
    };

    const text = (s) => document.createTextNode(s);

    add('Số dòng trả về', text(`${res.row_count.toLocaleString('en-US')} (giới hạn ${Number(res.row_limit).toLocaleString('en-US')})`));
    add('Bị cắt bớt', text(res.truncated ? 'Có' : 'Không'));
    add('Thời gian chạy', text(`${formatMs(res.elapsed_ms)} ms (đo phía ${byWhom})`));

    const chips = document.createElement('div');
    chips.className = 'chips';
    const used = res.tables_used || [];
    if (used.length) {
      for (const t of used) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = t;
        chips.appendChild(c);
      }
    } else {
      chips.appendChild(text('Không đọc bảng nào.'));
    }
    add('Bảng đã đọc', chips);

    if (res.executed_sql) {
      const pre = document.createElement('pre');
      pre.className = 'sql-pre';
      pre.textContent = res.executed_sql;
      add('Câu lệnh máy chủ đã chạy', pre);
      const note = document.createElement('p');
      note.className = 'muted small';
      note.textContent =
        'Máy chủ chuẩn hoá lại câu lệnh của bạn trước khi chạy (bỏ chú thích, ghi rõ tên schema). Dùng để đối chiếu, không cần chép ngược lại ô soạn thảo.';
      detailEl.appendChild(note);
    }
  }

  function formatMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '—';
    return n < 10 ? n.toFixed(2) : n.toFixed(0);
  }

  return {
    show,
    clear,
    clearDetail: () => {
      if (!detailEl) return;
      detailEl.innerHTML = '<p class="empty">Chạy một câu truy vấn để xem chi tiết.</p>';
    },
  };
}

/* Query history.
 *
 * Stores the student's own SQL text so a page reload does not lose their work.
 * Four deliberate constraints:
 *
 *   1. History is NEVER used as an autocomplete source. If a student types a
 *      name that the API does not know, that name must not come back as a
 *      suggestion later (see the source rule in editor.js).
 *   2. No result rows are stored — only the SQL, the outcome and counters.
 *   3. Storage is sessionStorage, NOT localStorage. Lab machines are shared:
 *      localStorage would hand the next person at the keyboard the previous
 *      student's work simply by opening the page. sessionStorage survives F5
 *      and an expired-session re-login (which is the case that matters) and
 *      dies with the tab.
 *   4. `purge()` wipes it on sign-out, so the shared machine is clean even
 *      before the tab is closed. A pre-existing localStorage history from the
 *      version before login existed is deleted on first load.
 */

const KEY = 'aivbank.sql.history.v1';
const LEGACY_LOCAL_KEY = 'aivbank.sql.history.v1';

/** One-off cleanup of the pre-auth localStorage history. */
function dropLegacyLocal() {
  try {
    localStorage.removeItem(LEGACY_LOCAL_KEY);
  } catch (_) {
    /* private browsing: nothing to clean */
  }
}

export function createHistoryPanel({ listEl, clearBtn, limit = 50, onPick }) {
  dropLegacyLocal();
  let items = read();

  clearBtn.addEventListener('click', () => {
    items = [];
    write(items);
    render();
  });

  function read() {
    try {
      const raw = sessionStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function write(v) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(v));
    } catch (_) {
      /* private browsing / quota: history is a convenience, not a requirement */
    }
  }

  /** Sign-out: remove the stored copy AND the in-memory list AND the DOM. */
  function purge() {
    items = [];
    try {
      sessionStorage.removeItem(KEY);
    } catch (_) {
      /* nothing stored to remove */
    }
    dropLegacyLocal();
    render();
  }

  function add(entry) {
    items.unshift({ ...entry, at: Date.now() });
    if (items.length > limit) items.length = limit;
    write(items);
    render();
  }

  function render() {
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.innerHTML = '<p class="empty">Chưa có câu truy vấn nào.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'hist' + (it.ok ? '' : ' hist-err');

      const meta = document.createElement('div');
      meta.className = 'hist-meta';
      const time = new Date(it.at).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const badge = document.createElement('span');
      badge.className = it.ok ? 'pill pill-ok' : 'pill pill-err';
      badge.textContent = it.ok
        ? `${Number(it.row_count).toLocaleString('en-US')} dòng · ${it.elapsed_ms} ms`
        : it.error_code || 'lỗi';
      meta.appendChild(badge);
      const t = document.createElement('span');
      t.className = 'muted small';
      t.textContent = time;
      meta.appendChild(t);

      const code = document.createElement('pre');
      code.className = 'hist-sql';
      code.textContent = it.sql;

      row.appendChild(meta);
      row.appendChild(code);
      row.title = 'Bấm để đưa lại câu này vào ô soạn thảo';
      row.addEventListener('click', () => onPick(it.sql));
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick(it.sql);
      });
      frag.appendChild(row);
    }
    listEl.appendChild(frag);
  }

  render();
  return { add, render, purge };
}

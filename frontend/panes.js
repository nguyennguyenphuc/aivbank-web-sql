/**
 * Kéo giãn khung: bề rộng danh sách bảng, và chiều cao ô soạn thảo.
 *
 * VÌ SAO CẦN
 *
 * Tên bảng dài bị cắt bằng dấu ba chấm (`bridge_loan_collate…`) trong một sidebar
 * rộng cố định 304px. `schema.js` đã đặt `title` nên di chuột vào là thấy đủ chữ,
 * nhưng đọc một danh sách bằng cách rê chuột từng dòng thì không dùng được.
 *
 * CÁCH LÀM
 *
 * Không đụng tới bố cục. Kích thước đã là biến CSS và đã được `.layout`,
 * `.workspace`, `.sandbox`, `.sandbox-main` dùng chung, nên việc ở đây chỉ là ghi
 * biến lên `:root` — console và khu vực Thực hành SQL tự đi cùng nhau, không cần
 * hai đường mã.
 *
 * BA ĐIỀU DỄ SAI, đã tính:
 *
 *   1. Chiều cao ô soạn thảo bị `min(var(--editor-row-h), var(--editor-max-h))`
 *      chặn ở 300px. Chỉ ghi `--editor-row-h` thì kéo quá 300px là thanh đứng im
 *      và trông như hỏng. Phải ghi CẢ HAI.
 *   2. `body.results-max` ẩn sidebar và ô soạn thảo; thanh kéo phải ẩn theo, nếu
 *      không sẽ còn hai vạch lơ lửng không kéo được gì. Việc đó do CSS lo.
 *   3. Ghi nhớ bằng `sessionStorage`, KHÔNG phải `localStorage` — luật của dự án,
 *      nêu ở `history.js`: máy phòng lab dùng chung, `localStorage` giao lại thứ
 *      của người trước cho người sau.
 */

const KEY = 'aivb.panes.v1';

/** px. Dưới ngưỡng này thì khung không còn đọc được nữa. */
const LIMITS = {
  sidebar: { min: 200, max: () => Math.min(640, window.innerWidth * 0.45) },
  // Trần của ô soạn thảo tính theo vùng làm việc chứ không phải một số cố định:
  // để lại ít nhất 200px cho vùng kết quả, nếu không người dùng tự kéo mất chỗ
  // hiển thị kết quả và tưởng là hỏng.
  editor: { min: 120, max: (host) => Math.max(160, host.clientHeight - 200) },
};

const root = document.documentElement;

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function save(state) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch (_) {
    /* chế độ riêng tư, hoặc hết chỗ. Kéo vẫn chạy, chỉ là không nhớ. */
  }
}

const state = load();

function applySidebar(px) {
  root.style.setProperty('--sidebar-w', `${Math.round(px)}px`);
}

function applyEditor(px) {
  const v = `${Math.round(px)}px`;
  // Cả hai, xem ghi chú (1) ở đầu tệp.
  root.style.setProperty('--editor-row-h', v);
  root.style.setProperty('--editor-max-h', v);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Gắn một thanh kéo.
 *
 * @param {HTMLElement} bar     phần tử `role="separator"`
 * @param {'sidebar'|'editor'} kind
 * @param {() => HTMLElement} hostOf  vùng chứa, để tính toạ độ và trần
 */
function wire(bar, kind, hostOf) {
  const vertical = kind === 'sidebar'; // kéo ngang -> đổi bề rộng
  const apply = vertical ? applySidebar : applyEditor;

  const maxOf = () => {
    const host = hostOf();
    return vertical ? LIMITS.sidebar.max() : LIMITS.editor.max(host);
  };
  const minOf = () => (vertical ? LIMITS.sidebar.min : LIMITS.editor.min);

  /** Khung mà thanh này chỉnh kích thước. */
  const panelOf = () =>
    hostOf().querySelector(vertical ? '.sidebar, .sandbox-left' : '.editor-panel');

  const currentPx = () => {
    const el = panelOf();
    if (!el) return minOf();
    const r = el.getBoundingClientRect();
    return vertical ? r.width : r.height;
  };

  const commit = (px) => {
    const next = clamp(px, minOf(), maxOf());
    apply(next);
    state[kind] = next;
    save(state);
    bar.setAttribute('aria-valuenow', String(Math.round(next)));
  };

  bar.addEventListener('pointerdown', (event) => {
    // Chỉ nút chính. Chuột phải mở menu ngữ cảnh chứ không được bắt đầu kéo.
    if (event.button !== 0) return;
    event.preventDefault();
    // Gốc toạ độ lấy từ MÉP CỦA CHÍNH KHUNG, không phải mép vùng chứa. `.workspace`
    // có `padding: var(--workspace-pad)`, nên đo từ vùng chứa sẽ lệch đúng bằng
    // phần đệm đó — kéo một cái là thanh nhảy.
    const el = panelOf();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const origin = vertical ? r.left : r.top;
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('is-dragging');
    document.body.classList.add('is-resizing');

    const onMove = (e) => {
      commit((vertical ? e.clientX : e.clientY) - origin);
    };
    const onUp = () => {
      bar.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  });

  // Bàn phím không phải phần thêm cho vui: cả giao diện này đã theo lối đó
  // (aria-live, sr-only, focus-visible ở khắp nơi). Một thanh kéo chỉ dùng được
  // bằng chuột là một khung không chỉnh được đối với người dùng bàn phím.
  bar.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 12;
    const less = vertical ? 'ArrowLeft' : 'ArrowUp';
    const more = vertical ? 'ArrowRight' : 'ArrowDown';
    let next;
    if (event.key === less) next = currentPx() - step;
    else if (event.key === more) next = currentPx() + step;
    else if (event.key === 'Home') next = minOf();
    else if (event.key === 'End') next = maxOf();
    else return;
    event.preventDefault();
    commit(next);
  });

  // Nhấn đúp = về mặc định. Rẻ, và là lối thoát khi ai đó kéo lỡ tay.
  bar.addEventListener('dblclick', () => {
    delete state[kind];
    save(state);
    root.style.removeProperty(vertical ? '--sidebar-w' : '--editor-row-h');
    if (!vertical) root.style.removeProperty('--editor-max-h');
    bar.removeAttribute('aria-valuenow');
  });
}

/** Gắn mọi thanh kéo có trong trang và khôi phục kích thước đã nhớ. */
export function initPanes() {
  if (Number.isFinite(state.sidebar)) applySidebar(state.sidebar);
  if (Number.isFinite(state.editor)) applyEditor(state.editor);

  for (const bar of document.querySelectorAll('[data-resize]')) {
    const kind = bar.dataset.resize; // 'sidebar' | 'editor'
    if (kind !== 'sidebar' && kind !== 'editor') continue;
    // Vùng chứa là cha của thanh: `.layout`/`.sandbox` cho bề rộng,
    // `.workspace`/`.sandbox-main` cho chiều cao. Cả hai đều là cha trực tiếp.
    wire(bar, kind, () => bar.parentElement);
  }
}

/* Session model, login-failure wording, and the client-side password hints.
 *
 * Three rules shape this file:
 *
 * 1. NO PASSWORD IS EVER STORED. Not in localStorage, not in sessionStorage, not
 *    in a module variable, not in a closure kept alive after the request. Every
 *    function here takes the password as an argument and drops it; authgate.js
 *    blanks the <input> in a finally block. The only thing that survives a call
 *    is the HttpOnly cookie the browser holds and JavaScript cannot read.
 *
 * 2. A FAILED LOGIN NEVER REVEALS WHETHER THE USERNAME EXISTS. `loginErrorText`
 *    deliberately throws away the backend's message for a 401 and returns one
 *    fixed sentence. This is the one place the "show the server message
 *    verbatim" rule of API_CONTRACT.md §9.4 is overridden, and it is overridden
 *    in the safe direction: we show less, never more. If the backend is later
 *    changed to say "no such user", this UI still says nothing.
 *
 * 3. THE SERVER DECIDES. `checkPasswordRules` exists so a student is not bounced
 *    back and forth for an obviously too-short password. It is a courtesy check,
 *    not a policy: whatever the server refuses, its message is shown verbatim.
 */

import { api } from './api.js';

const CFG = window.AIVB_CONFIG;

export const ROLE_STUDENT = 'STUDENT';
export const ROLE_INSTRUCTOR = 'INSTRUCTOR';

/**
 * Normalise whatever /auth/me or /auth/login returned into one shape.
 *
 * Field names are read defensively (snake_case first, then a couple of common
 * spellings) because the auth contract described these two fields in prose
 * rather than pinning them. An unrecognised role is treated as STUDENT-like for
 * layout but is displayed verbatim, so a new role never silently renders as if
 * it were a student session.
 */
export function normaliseSession(data) {
  if (!data || typeof data !== 'object') return null;
  const raw = data.session && typeof data.session === 'object' ? data.session : data;

  const username =
    firstString(raw.username, raw.user_name, raw.user, raw.name, raw.login) || '';
  const role = (firstString(raw.role, raw.user_role) || '').toUpperCase();
  const mustChange = Boolean(
    pickBool(raw.must_change_password, raw.mustChangePassword, raw.password_change_required)
  );

  if (!username && !role) return null;
  return { username, role, mustChangePassword: mustChange };
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}
function pickBool(...vals) {
  for (const v of vals) if (typeof v === 'boolean') return v;
  for (const v of vals) if (v === 'true' || v === 1) return true;
  return false;
}

export function isInstructor(session) {
  return Boolean(session) && session.role === ROLE_INSTRUCTOR;
}

/** Short label for the role badge. Unknown roles are shown as-is, not hidden. */
export function roleLabel(session) {
  if (!session || !session.role) return 'Không rõ vai trò';
  if (session.role === ROLE_INSTRUCTOR) return 'GIẢNG VIÊN';
  if (session.role === ROLE_STUDENT) return 'Học viên';
  return session.role;
}

/* --- calls ---------------------------------------------------------------- */

/** Current session, or null when the server says 401. Rethrows real failures. */
export async function fetchSession() {
  try {
    return normaliseSession(await api.me());
  } catch (err) {
    if (err && err.http_status === 401) return null;
    throw err;
  }
}

export async function login(username, password) {
  return normaliseSession(await api.login(username, password));
}

export async function logout() {
  // A failed logout must never leave the student looking logged in. The caller
  // wipes local state and reloads regardless of what comes back here.
  try {
    await api.logout();
    return true;
  } catch (_) {
    return false;
  }
}

export async function changePassword(oldPassword, newPassword) {
  return api.changePassword(oldPassword, newPassword);
}

/* --- login failure wording ------------------------------------------------- */

const GENERIC_LOGIN_FAILURE = 'Tên đăng nhập hoặc mật khẩu không đúng.';

/** Codes/statuses that mean "too many attempts, wait". Matched loosely on
 *  purpose: the exact code was not pinned in the contract, and guessing wrong
 *  must degrade to the generic message, never to a leakier one. */
function isLockout(err) {
  if (!err) return false;
  if (err.http_status === 429) return true;
  const code = String(err.error_code || '');
  return /LOCK|ATTEMPT|RATE_LIMIT|TOO_MANY/i.test(code);
}

function formatWait(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${seconds} giây`;
  const m = Math.ceil(seconds / 60);
  return `${m} phút`;
}

/**
 * The sentence shown under the login form.
 *
 * 401 -> always the same sentence, whatever the server said. A wrong username
 * and a wrong password are indistinguishable here, which is the whole point:
 * otherwise the login form becomes a roster of who is enrolled.
 */
export function loginErrorText(err) {
  if (!err) return GENERIC_LOGIN_FAILURE;

  if (isLockout(err)) {
    const wait = formatWait(err.retry_after_s);
    return wait
      ? `Tài khoản tạm thời bị khoá do nhập sai nhiều lần. Vui lòng thử lại sau ${wait}.`
      : 'Tài khoản tạm thời bị khoá do nhập sai nhiều lần. Vui lòng thử lại sau ít phút.';
  }

  if (err.http_status === 401) return GENERIC_LOGIN_FAILURE;

  // Network / server-side breakage is a different kind of problem and saying so
  // helps the student (and the lab technician). It reveals nothing about accounts.
  if (err.error_code === 'E_CLIENT_NETWORK') {
    return 'Không kết nối được tới máy chủ. Hãy báo giảng viên hoặc quản trị hệ thống.';
  }
  if (err.error_code === 'E_CLIENT_CROSS_ORIGIN') {
    return 'Cấu hình không an toàn: giao diện và API phải dùng cùng một địa chỉ origin.';
  }
  if (err.error_code === 'E_CLIENT_BAD_REQUEST') {
    return 'Chưa nhập đủ tên đăng nhập và mật khẩu.';
  }
  if (err.http_status && err.http_status >= 500) {
    return 'Máy chủ đang gặp sự cố nên chưa đăng nhập được. Hãy thử lại sau ít phút.';
  }
  if (err.http_status === 403) {
    return 'Yêu cầu đăng nhập bị từ chối. Hãy tải lại trang rồi thử lại.';
  }
  return GENERIC_LOGIN_FAILURE;
}

/**
 * The sentence shown under the change-password form.
 * Server messages are shown verbatim here — unlike login, a rejected new
 * password says something about the password just typed, not about who exists.
 */
export function passwordErrorText(err) {
  if (!err) return 'Không đổi được mật khẩu.';
  if (isLockout(err)) {
    const wait = formatWait(err.retry_after_s);
    return wait
      ? `Đã thử sai quá nhiều lần. Vui lòng thử lại sau ${wait}.`
      : 'Đã thử sai quá nhiều lần. Vui lòng thử lại sau ít phút.';
  }
  if (err.error_code === 'E_BAD_CREDENTIALS') {
    return 'Mật khẩu hiện tại không đúng.';
  }
  if (sessionIsGone(err)) {
    return 'Phiên đã hết hạn. Hãy đăng nhập lại.';
  }
  if (err.error_code === 'E_CLIENT_NETWORK') {
    return 'Không kết nối được tới máy chủ. Hãy thử lại.';
  }
  if (err.error_code === 'E_CLIENT_CROSS_ORIGIN') {
    return 'Không thể gửi mật khẩu tới API khác origin. Hãy báo quản trị hệ thống.';
  }
  // E_WEAK_PASSWORD and friends: the server's own wording, verbatim. It talks
  // about the password just typed, never about which accounts exist.
  return err.message || 'Máy chủ từ chối mật khẩu mới. Hãy chọn mật khẩu khác.';
}

/** True only for "your session is no longer valid", not "wrong password". */
export function sessionIsGone(err) {
  return Boolean(err) && err.http_status === 401 && err.error_code !== 'E_BAD_CREDENTIALS';
}

/* --- client-side password hints -------------------------------------------- */

/**
 * Substrings the server refuses outright (api/authstore.py
 * validate_password_strength). Mirrored here only so a student is told before
 * the round trip, not after. This list is a copy of a server rule, not a
 * client policy: if the server's list changes, this one is merely out of date,
 * never authoritative.
 */
const WEAK_SUBSTRINGS = ['password', '123456789', 'qwerty', 'aivbank', 'letmein'];

/**
 * Returns a checklist the form renders live. Advisory only.
 *
 * Every line here mirrors a rule the server actually enforces. Nothing extra is
 * invented: a client stricter than the server would reject passwords the server
 * would have accepted, which is precisely the annoyance this check exists to
 * prevent rather than cause.
 */
export function checkPasswordRules(newPassword, { oldPassword = '', username = '' } = {}) {
  const min = Number(CFG.passwordMinLength) || 12;
  const pw = newPassword || '';
  const uname = (username || '').trim().toLowerCase();
  const lowered = pw.toLowerCase();
  const weakHit = WEAK_SUBSTRINGS.find((w) => lowered.includes(w));

  const rules = [
    { key: 'len', label: `Ít nhất ${min} ký tự`, ok: pw.length >= min },
    {
      key: 'blank',
      label: 'Không chỉ gồm khoảng trắng',
      ok: pw.trim().length > 0,
    },
    {
      key: 'diff',
      label: 'Khác mật khẩu hiện tại',
      ok: pw.length > 0 && pw !== oldPassword,
    },
    {
      key: 'uname',
      label: 'Không trùng tên đăng nhập',
      ok: !uname || lowered !== uname,
    },
    {
      key: 'weak',
      label: weakHit
        ? `Không chứa chuỗi dễ đoán (đang chứa “${weakHit}”)`
        : 'Không chứa chuỗi dễ đoán',
      ok: !weakHit,
    },
  ];

  return { rules, ok: rules.every((r) => r.ok) };
}

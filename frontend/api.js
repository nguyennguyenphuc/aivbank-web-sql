/* Thin client for the AIV Bank student SQL API.
 *
 * Responsibilities:
 *   - build request URLs from window.AIVB_CONFIG
 *   - carry the session cookie (credentials:'same-origin') and the CSRF marker
 *     header on every state-changing request
 *   - normalise every failure (HTTP error envelope, 422, network, abort) into one
 *     shape: { ok: false, error_code, message, http_status, client }
 *   - preserve exact integer digits so money (INTEGER VND) is never silently rounded
 *
 * Explicit non-responsibilities:
 *   - it does NOT know any table or column name
 *   - it does NOT rewrite or reinterpret backend messages (API_CONTRACT.md §9.4)
 *   - it does NOT read, write or inspect the session cookie. The cookie is
 *     HttpOnly by contract: document.cookie cannot see it and nothing here tries.
 *     "Am I logged in?" is answered by GET /auth/me, never by a client guess.
 */

const CFG = window.AIVB_CONFIG;

/** Header the backend requires on every POST as its CSRF marker. */
const CLIENT_HEADER = 'X-AIVB-Client';
const CLIENT_HEADER_VALUE = 'web';

function apiBase() {
  // Never let an untrusted link choose where credentials are submitted. The
  // deployment-owned config file is the only source for an API origin.
  const base = (CFG.apiBase || '').trim();
  return base.replace(/\/+$/, '');
}

/** Human-readable origin, used only in network-failure text. */
function apiOrigin() {
  const base = apiBase();
  if (!base) return location.origin;
  try {
    return new URL(base, location.href).origin;
  } catch (_) {
    return base;
  }
}

/**
 * True when the configured API lives on a different origin than this page.
 *
 * This matters because the session is a cookie sent with credentials:
 * 'same-origin'. Cross-origin means the browser never attaches it, so login
 * would appear to succeed and every following request would come back 401.
 * app.js surfaces this as a banner instead of letting it look like a bug.
 */
function isCrossOrigin() {
  return apiOrigin() !== location.origin;
}

/* --- 401 hook --------------------------------------------------------------
 * A session can expire mid-session. Any guarded endpoint answering 401 must
 * bring the login screen back without losing what the student was typing, so
 * the handler is installed once by app.js rather than checked at 20 call sites.
 * Requests to /auth/* are exempt: a 401 from /auth/me is the normal "not logged
 * in yet" answer and a 401 from /auth/login is a wrong password, neither of
 * which is a session expiry.
 */
let onUnauthorized = null;
/** fn(reason) where reason is 'expired' | 'password_change_required'. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}
function isAuthPath(path) {
  return path.startsWith('/auth/');
}

/* --- exact-integer JSON parsing -------------------------------------------
 * DuckDB money columns are BIGINT VND. A BIGINT larger than 2^53-1 would lose
 * digits through plain JSON.parse without any error being raised. Where the
 * runtime supports the JSON.parse source-text reviver (ES2025), we keep the
 * original digits as an ExactNumber so the grid can print them verbatim.
 * Where it is not supported we fall back to plain JSON.parse; the renderer
 * flags any unsafe integer it sees so a wrong number is never shown silently.
 */
export function isExact(v) {
  return v !== null && typeof v === 'object' && typeof v.__exactDigits === 'string';
}

let reviverSupportsSource = null;
function detectReviverSource() {
  if (reviverSupportsSource !== null) return reviverSupportsSource;
  try {
    let seen = false;
    JSON.parse('1', (k, v, ctx) => {
      if (ctx && typeof ctx.source === 'string') seen = true;
      return v;
    });
    reviverSupportsSource = seen;
  } catch (_) {
    reviverSupportsSource = false;
  }
  return reviverSupportsSource;
}

export function parseJsonExact(text) {
  if (!detectReviverSource()) return JSON.parse(text);
  return JSON.parse(text, function (key, value, context) {
    if (
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      context &&
      typeof context.source === 'string' &&
      /^-?\d+$/.test(context.source)
    ) {
      return { __exactDigits: context.source };
    }
    return value;
  });
}

/* --- error normalisation --------------------------------------------------- */

function clientError(code, message, extra = {}) {
  return { ok: false, error_code: code, message, client: true, ...extra };
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return parseJsonExact(text);
  } catch (_) {
    return null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  // Cookie auth only works same-origin. More importantly, do not send a login
  // or password-change body to a cross-origin URL even when that host opts in
  // through CORS. A deployment mistake must fail closed before fetch().
  if (isCrossOrigin() && method !== 'GET' && method !== 'HEAD') {
    throw clientError(
      'E_CLIENT_CROSS_ORIGIN',
      'Giao diện và API phải được phục vụ từ cùng một origin.'
    );
  }
  const url = apiBase() + path;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Sent on every state-changing request; the backend rejects POSTs without it.
  // A cross-site form or <img> cannot set a custom header, which is the point.
  if (method !== 'GET' && method !== 'HEAD') headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;

  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      // The session lives in an HttpOnly cookie. Without this the browser sends
      // nothing and every guarded call is a 401.
      credentials: 'same-origin',
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw clientError('E_CLIENT_ABORTED', 'Yêu cầu đã bị huỷ.');
    }
    throw clientError('E_CLIENT_NETWORK', `Không kết nối được tới máy chủ tại ${apiOrigin()}.`);
  }

  const data = await readBody(res);

  if (res.ok) {
    if (data === null) {
      throw clientError('E_CLIENT_BAD_RESPONSE', 'Máy chủ trả về dữ liệu không đọc được.', {
        http_status: res.status,
      });
    }
    return data;
  }

  if (!isAuthPath(path) && onUnauthorized) {
    // Session gone (expired, revoked, server restarted). Hand it to app.js so
    // the login screen comes back with the student's SQL still in the editor.
    if (res.status === 401) {
      onUnauthorized('expired');
    } else if (res.status === 403 && data && data.error_code === 'E_PASSWORD_CHANGE_REQUIRED') {
      // A live session that is parked on the forced first-login change. The
      // backend answers every data endpoint this way until the password is
      // set, so the UI must send the student to that form rather than show a
      // permission error they cannot act on.
      onUnauthorized('password_change_required');
    }
  }

  // FastAPI validation errors (422) do NOT use the error_code envelope — the
  // contract says to treat them as "the request itself was invalid" (§7).
  if (res.status === 422) {
    throw clientError('E_CLIENT_BAD_REQUEST', 'Yêu cầu gửi lên máy chủ không hợp lệ.', {
      http_status: 422,
    });
  }

  if (data && typeof data.error_code === 'string') {
    // Backend message is passed through verbatim. Never edited, never re-worded.
    // (auth.js is the one deliberate exception: a failed login is flattened to a
    // single neutral sentence so the UI cannot become a username oracle.)
    return Promise.reject({
      ok: false,
      error_code: data.error_code,
      message: typeof data.message === 'string' ? data.message : '',
      http_status: res.status,
      retry_after_s: pickRetryAfter(data, res),
      client: false,
    });
  }

  throw clientError('E_CLIENT_BAD_RESPONSE', `Máy chủ trả về lỗi HTTP ${res.status}.`, {
    http_status: res.status,
    retry_after_s: pickRetryAfter(data, res),
  });
}

/**
 * Seconds the caller must wait, for lockout / rate-limit answers.
 * Several spellings are accepted because this is the one part of the auth
 * contract that was described in prose rather than pinned to a field name.
 * Anything unrecognised yields null and the UI falls back to a generic wait
 * message rather than inventing a number.
 */
function pickRetryAfter(data, res) {
  const candidates = [
    data && data.retry_after_s,
    data && data.retry_after_seconds,
    data && data.retry_after,
    data && data.locked_for_s,
    res && res.headers && res.headers.get('Retry-After'),
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return null;
}

/* --- endpoints (API_CONTRACT.md §3–§7) ------------------------------------- */

/* --- current dataset -------------------------------------------------------
 *
 * Which teaching dataset the console is pointed at is AMBIENT state, like the
 * base URL: it belongs to the session, not to each call. Holding it here rather
 * than threading it through every caller means no call site can forget it - and
 * a forgotten dataset would not fail loudly, it would quietly query the wrong
 * one and show the student another dataset's table names.
 *
 * Set it from the section switcher; schema.js and mart.js never touch it.
 */
let currentDataset = null;

export function setDataset(name) {
  currentDataset = name || null;
}

export function getDataset() {
  return currentDataset;
}

/** Build a query string, dropping empty values so a URL never grows a bare
 *  `?dataset=` that the server would then have to interpret. */
function qs(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v === true ? 'true' : v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const api = {
  /* --- session -------------------------------------------------------------
   * No password ever leaves these four calls. It is read from the input, passed
   * straight into the request body, and the caller wipes the field: nothing is
   * kept in a variable, a closure, localStorage or sessionStorage.
   */

  /** 200 => session info; 401 => not logged in (an expected answer, not a bug). */
  me: () => request('/auth/me'),

  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),

  logout: () => request('/auth/logout', { method: 'POST', body: {} }),

  /**
   * The handover note for this contract called the first field `old_password`;
   * the implemented endpoint (api/models.py PasswordChangeRequest) calls it
   * `current_password`. Both are sent. The model ignores unknown keys, so this
   * works against either spelling and cannot 422 on the one it does not want.
   * Drop the alias once the contract document and the code agree.
   */
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', {
      method: 'POST',
      body: {
        current_password: currentPassword,
        old_password: currentPassword,
        new_password: newPassword,
      },
    }),

  health: () => request('/health'),

  /** Which teaching datasets this session may use. The ONLY source of dataset
   *  names and labels - the UI must not carry its own list, for the same reason
   *  it must not carry a list of tables. */
  datasets: () => request('/datasets'),

  /** Sidebar list: [{ name, column_count }]. The ONLY source of table names. */
  tables: (dataset = currentDataset) => request(`/schema/tables${qs({ dataset })}`),

  /** Full schema, used to power autocomplete. The ONLY source of column names. */
  schema: (dataset = currentDataset) => request(`/schema${qs({ dataset })}`),

  /** Role-visible analytical marts. The ONLY source of mart names. */
  marts: (includeRowCount = true, dataset = currentDataset) =>
    request(`/schema/marts${qs({ include_row_count: includeRowCount || null, dataset })}`),

  /** Role-visible columns for one mart selected from marts(). */
  mart: (name, includeRowCount = true, dataset = currentDataset) =>
    request(
      `/schema/marts/${encodeURIComponent(name)}` +
        qs({ include_row_count: includeRowCount || null, dataset })
    ),

  /** Detail for one table. 404 => E_UNKNOWN_TABLE, shown verbatim. */
  table: (name, includeRowCount = true, dataset = currentDataset) =>
    request(
      `/schema/tables/${encodeURIComponent(name)}` +
        qs({ include_row_count: includeRowCount || null, dataset })
    ),

  gamificationMe: () => request("/gamification/me"),
  gameStatus: () => request("/game-sso/status"),
  leaderboard: (period = "week") => request(`/gamification/leaderboard?period=${encodeURIComponent(period)}`),
  instructorAnalytics: () => request("/admin/analytics/queries"),

  query: (sql, maxRows, signal, dataset = currentDataset) =>
    request('/query', {
      method: 'POST',
      // `dataset` di trong BODY chu khong phai query string: no thuoc ve mo ta
      // cua lan chay, va may chu ghi no vao audit cung voi cau SQL.
      body: {
        sql,
        ...(maxRows ? { max_rows: maxRows } : {}),
        ...(dataset ? { dataset } : {}),
      },
      signal,
    }),
};

export { apiBase, apiOrigin, isCrossOrigin };

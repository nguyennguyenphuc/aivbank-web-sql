/* The login gate: a full-viewport overlay that owns "is the console usable yet".
 *
 * Why an overlay and not a separate page: the whole console is one page, and a
 * session can die between two keystrokes. An overlay can come back over an
 * editor that still holds the student's unsaved SQL, and take it away again
 * after a successful re-login, without a navigation that would lose the text.
 *
 * What it guarantees:
 *   - The app shell stays `hidden` until the SERVER has confirmed a session.
 *     The gate is visible in the HTML by default, so if this script fails to
 *     load the student sees a login form, never the console. Fail closed.
 *   - `must_change_password` blocks the console just as hard as no session at
 *     all. There is no "remind me later".
 *   - Passwords are read from the field, passed to one function, and the field
 *     is blanked in a finally. Nothing is retained.
 *   - If a DIFFERENT user logs in after an expiry, the caller is told, so the
 *     first user's SQL and history do not survive into the second user's session.
 */

import {
  fetchSession,
  login,
  logout,
  changePassword,
  checkPasswordRules,
  loginErrorText,
  passwordErrorText,
  sessionIsGone,
} from './auth.js';

const $ = (id) => document.getElementById(id);

export function createAuthGate({ appEl, onSession, onSignedOut }) {
  const root = $('auth-gate');
  const steps = {
    checking: $('auth-checking'),
    login: $('auth-login'),
    change: $('auth-change'),
  };

  const loginForm = steps.login;
  const changeForm = steps.change;

  const elUser = $('login-username');
  const elPass = $('login-password');
  const elLoginErr = $('login-error');
  const elLoginBtn = $('login-submit');
  const elNotice = $('auth-notice');

  const elOld = $('change-old');
  const elNew = $('change-new');
  const elNew2 = $('change-new2');
  const elChangeErr = $('change-error');
  const elChangeBtn = $('change-submit');
  const elChangeCancel = $('change-cancel');
  const elChangeSignout = $('change-signout');
  const elChangeLead = $('change-lead');
  const elRules = $('change-rules');
  const elChangeOk = $('change-ok');

  let session = null;
  let lastUsername = null;
  let busy = false;
  let changeMode = 'forced'; // 'forced' | 'voluntary'

  /* ------------------------------ plumbing ------------------------------- */

  function step(name) {
    for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
  }

  function showGate() {
    root.hidden = false;
    // Belt and braces: the shell is hidden AND the overlay is opaque, so no
    // repaint order or CSS edit can flash the table list behind the form.
    if (appEl) appEl.hidden = true;
    document.body.classList.add('is-gated');
  }

  function hideGate() {
    root.hidden = true;
    if (appEl) appEl.hidden = false;
    document.body.classList.remove('is-gated');
  }

  function setError(el, text) {
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.textContent = text;
    el.hidden = false;
  }

  function setNotice(text) {
    setError(elNotice, text);
  }

  function setBusy(on, btn, labelBusy, labelIdle) {
    busy = on;
    btn.disabled = on;
    btn.textContent = on ? labelBusy : labelIdle;
  }

  /** Blank a password field. Called in a finally so it also runs on failure. */
  function wipe(...fields) {
    for (const f of fields) if (f) f.value = '';
  }

  /* -------------------------------- login -------------------------------- */

  function showLogin({ notice = null, username = '' } = {}) {
    step('login');
    showGate();
    setError(elLoginErr, null);
    setNotice(notice);
    elUser.value = username;
    wipe(elPass);
    // A returning student after an expiry only has to retype the password.
    (username ? elPass : elUser).focus();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const username = elUser.value.trim();
    const password = elPass.value;

    if (!username || !password) {
      setError(elLoginErr, 'Hãy nhập cả tên đăng nhập và mật khẩu.');
      return;
    }

    // Blank the field NOW, not in the finally. On a successful login the finally
    // does not run until onSession() has finished loading health and the whole
    // schema — several seconds during which the plaintext password would still
    // be sitting in a DOM input on a shared lab machine, readable by anything
    // with a debugger or a screen reader. The finally below is kept as a
    // second line of defence, not as the only one.
    wipe(elPass);

    setError(elLoginErr, null);
    setBusy(true, elLoginBtn, 'Đang đăng nhập…', 'Đăng nhập');
    try {
      const s = await login(username, password);
      if (!s) {
        // 200 without a usable body: treat as a failure rather than guessing.
        setError(elLoginErr, 'Máy chủ trả về phản hồi không đọc được. Hãy thử lại.');
        return;
      }
      await accept(s);
    } catch (err) {
      // One sentence for every wrong-credential case (auth.js explains why).
      setError(elLoginErr, loginErrorText(err));
      elPass.focus();
    } finally {
      wipe(elPass);
      setBusy(false, elLoginBtn, 'Đang đăng nhập…', 'Đăng nhập');
    }
  });

  /* --------------------------- change password --------------------------- */

  function showChange(mode) {
    changeMode = mode;
    step('change');
    showGate();
    setError(elChangeErr, null);
    setError(elChangeOk, null);
    wipe(elOld, elNew, elNew2);
    renderRules();

    const forced = mode === 'forced';
    elChangeLead.textContent = forced
      ? 'Đây là lần đăng nhập đầu tiên. Hãy đặt mật khẩu mới trước khi vào bảng điều khiển.'
      : 'Nhập mật khẩu hiện tại và mật khẩu mới.';
    elChangeCancel.hidden = forced;
    elChangeSignout.hidden = !forced;
    elOld.focus();
  }

  function renderRules() {
    const { rules } = checkPasswordRules(elNew.value, {
      oldPassword: elOld.value,
      username: (session && session.username) || elUser.value,
    });
    elRules.innerHTML = '';
    for (const r of rules) {
      const li = document.createElement('li');
      li.className = 'auth-rule' + (r.ok ? ' is-ok' : '');
      const mark = document.createElement('span');
      mark.className = 'auth-rule-mark';
      mark.textContent = r.ok ? '✓' : '•';
      const txt = document.createElement('span');
      txt.textContent = r.label;
      li.appendChild(mark);
      li.appendChild(txt);
      elRules.appendChild(li);
    }
  }

  elNew.addEventListener('input', renderRules);
  elOld.addEventListener('input', renderRules);

  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const oldPw = elOld.value;
    const newPw = elNew.value;
    const confirm = elNew2.value;

    if (newPw !== confirm) {
      setError(elChangeErr, 'Hai ô mật khẩu mới chưa khớp nhau.');
      elNew2.focus();
      return;
    }
    const { ok } = checkPasswordRules(newPw, {
      oldPassword: oldPw,
      username: (session && session.username) || elUser.value,
    });
    if (!ok) {
      // Advisory only — the list above already says which line is unmet.
      setError(elChangeErr, 'Mật khẩu mới chưa đạt các yêu cầu bên dưới.');
      elNew.focus();
      return;
    }

    setError(elChangeErr, null);
    // Same reasoning as the login form: out of the DOM before the request, not
    // after the response finishes rendering the console.
    wipe(elOld, elNew, elNew2);
    renderRules();
    setBusy(true, elChangeBtn, 'Đang đổi…', 'Đổi mật khẩu');
    try {
      await changePassword(oldPw, newPw);
      // Re-ask the server rather than assuming the flag cleared. If it still
      // insists on a change, the student stays on this form.
      const s = await fetchSession();
      if (!s) {
        showLogin({
          notice: 'Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới.',
          username: lastUsername || '',
        });
        return;
      }
      if (changeMode === 'voluntary') {
        setError(elChangeOk, 'Đã đổi mật khẩu.');
        setTimeout(() => {
          if (!root.hidden && changeMode === 'voluntary') closeVoluntary();
        }, 900);
        session = s;
        return;
      }
      await accept(s);
    } catch (err) {
      setError(elChangeErr, passwordErrorText(err));
      // Only a dead session sends them back to login. A wrong *current*
      // password (also a 401) must keep them on this form.
      if (sessionIsGone(err)) {
        showLogin({
          notice: 'Phiên đã hết hạn. Hãy đăng nhập lại.',
          username: lastUsername || '',
        });
      }
    } finally {
      wipe(elOld, elNew, elNew2);
      renderRules();
      setBusy(false, elChangeBtn, 'Đang đổi…', 'Đổi mật khẩu');
    }
  });

  function closeVoluntary() {
    wipe(elOld, elNew, elNew2);
    setError(elChangeErr, null);
    setError(elChangeOk, null);
    hideGate();
  }

  elChangeCancel.addEventListener('click', () => {
    if (busy) return;
    closeVoluntary();
  });

  elChangeSignout.addEventListener('click', () => {
    if (busy) return;
    signOut();
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && changeMode === 'voluntary' && !steps.change.hidden && !busy) {
      closeVoluntary();
    }
  });

  /* ------------------------------- outcome -------------------------------- */

  /** A server-confirmed session. Either force the password change or open up. */
  async function accept(s) {
    if (s.mustChangePassword) {
      session = s;
      lastUsername = s.username || lastUsername;
      showChange('forced');
      return;
    }
    const sameUser = lastUsername === null || lastUsername === s.username;
    const first = session === null || lastUsername === null;
    session = s;
    lastUsername = s.username;
    hideGate();
    await onSession(s, { sameUser, first });
  }

  /* -------------------------------- boot ---------------------------------- */

  async function boot() {
    step('checking');
    showGate();
    let s = null;
    try {
      s = await fetchSession();
    } catch (err) {
      // Server unreachable / broken: still show the login form (never the
      // console), with an honest note about why.
      showLogin({ notice: loginErrorText(err) });
      return;
    }
    if (!s) {
      showLogin();
      return;
    }
    await accept(s);
  }

  /**
   * A guarded endpoint answered 401 mid-session.
   * The app shell is hidden but NOT wiped: the student's SQL is still in the
   * editor and comes back untouched when the same person logs in again.
   */
  function showExpired() {
    if (!root.hidden && steps.login.hidden === false) return; // already asking
    if (busy) return;
    showLogin({
      notice: 'Phiên làm việc đã hết hạn. Hãy đăng nhập lại — câu SQL bạn đang gõ vẫn được giữ nguyên.',
      username: lastUsername || '',
    });
  }

  /** Explicit sign-out. Everything client-side is destroyed by the caller. */
  async function signOut() {
    if (busy) return;
    busy = true;
    try {
      await logout();
    } finally {
      busy = false;
      session = null;
      await onSignedOut();
    }
  }

  /**
   * The session is alive but the server refuses data until the password is
   * changed (403 E_PASSWORD_CHANGE_REQUIRED). Same screen as a first login.
   */
  function requirePasswordChange() {
    if (busy) return;
    if (!root.hidden && steps.change.hidden === false && changeMode === 'forced') return;
    showChange('forced');
  }

  return {
    boot,
    showExpired,
    requirePasswordChange,
    signOut,
    openChangePassword: () => showChange('voluntary'),
    get session() {
      return session;
    },
  };
}

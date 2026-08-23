/* AIV Bank — Student SQL Console: deployment configuration.
 *
 * This is the ONLY file an operator normally needs to edit.
 * It contains no table names, no column names and no permission logic:
 * the API is the single source of truth for all of that (API_CONTRACT.md §9.1).
 */
window.AIVB_CONFIG = {
  // Base URL of the backend API.
  //
  // '' means "same origin as this page", and that is the only setting that
  // works with the cookie session: the login cookie is HttpOnly and every
  // request is sent with credentials:'same-origin', so a browser will simply
  // not attach it to a cross-origin API. Serve the UI and the API from one
  // origin (web/serve.py proxies /auth, /health, /schema and /query to the
  // backend in development; a reverse proxy does the same job in production).
  //
  // An absolute URL still works for the unauthenticated endpoints, but the
  // console will refuse to pretend it can log in across origins and shows a
  // warning banner instead.
  apiBase: '',

  // Row cap requested by default. The server clamps this to its own max_rows
  // (it can never be raised from here — see API_CONTRACT.md §7).
  //
  // 10,000 rather than 200: measured on the v5.1.6.4 student release, 55 of the
  // 77 tables hold fewer than 10,000 rows, so at this cap those 71% come back
  // COMPLETE instead of silently clipped at 200. Cost is bounded and measured —
  // 1,000 rows of the widest table is ~94 KB over the wire, so 10,000 is under
  // 1 MB against an 8 MB response ceiling, and the worst-case grid is
  // 10,000 x 13 = 130,000 cells, which renders without virtualisation.
  // Raising it further starts to hurt: the grid builds real DOM nodes.
  defaultMaxRows: 10000,

  // How many past queries to keep. History stores the student's own SQL text
  // only, lives in sessionStorage (per tab, gone when the tab closes) and is
  // never used as an autocomplete source.
  historyLimit: 50,

  // Client-side password hints for the forced first-login change. These are a
  // courtesy so students are not bounced by the server; the SERVER decides what
  // it accepts and its message is always shown verbatim when it refuses.
  //
  // Keep this equal to MIN_PASSWORD_LENGTH in api/authstore.py. Setting it
  // LOWER only costs a wasted round trip; setting it HIGHER would reject
  // passwords the server would have accepted, which is worse than not checking.
  passwordMinLength: 12,
};

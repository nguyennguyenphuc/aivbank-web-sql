# DuckDB-WASM — vendored, not installed

**Version 1.32.0**, from `@duckdb/duckdb-wasm` on npm. MIT (see `LICENSE`).

Vendored for the same reason CodeMirror is: a lab machine may have no route to
the internet, and a CDN is a third party running script on a page where students
type their password. Everything here is served from this app's own origin.

## What was copied, and what was not

Only the **`eh`** bundle (WebAssembly exception handling — Chrome 95+,
Firefox 100+, Safari 15.2+):

| File | Origin | sha256 (first 16) |
|---|---|---|
| `duckdb-eh.wasm` | `package/dist/duckdb-eh.wasm`, byte-identical | `4c221bfa59c11f24` |
| `duckdb-browser-eh.worker.js` | `package/dist/duckdb-browser-eh.worker.js`, byte-identical | `f8ab72b6b90b3ad8` |
| `duckdb-browser.js` | **bundled** from `package/dist/duckdb-browser.mjs` (see below) | `69c7e67b41c57e90` |
| `LICENSE` | upstream repo root | — |

**Deliberately absent:** the `mvp` bundle (37 MB, only for browsers without
exception handling) and the `coi` bundle (32 MB, needs cross-origin isolation
headers we do not send). Adding them would double or triple what a student
downloads for no gain in this lab.

## Three changes from upstream, all load-bearing

1. **`duckdb-browser.js` is a BUNDLE, not the upstream file.** The npm
   `duckdb-browser.mjs` is not self-contained: it carries a bare import of
   `apache-arrow` and expects a bundler to resolve it. Loaded straight from a
   web page it dies with

   > `Failed to resolve module specifier "apache-arrow"`

   The alternatives were worse. An `<script type="importmap">` is an INLINE
   script, so it would force `'unsafe-inline'` into `script-src` — a far bigger
   relaxation than the one feature is worth. So the file here is the upstream
   ESM entry bundled with `apache-arrow` inlined:

   ```bash
   npm install esbuild @duckdb/duckdb-wasm@1.32.0
   echo "export * from '@duckdb/duckdb-wasm/dist/duckdb-browser.mjs';" > entry.mjs
   npx esbuild entry.mjs --bundle --format=esm --platform=browser \
       --outfile=duckdb-browser.js --legal-comments=none --minify
   ```

   That is a build step run ONCE, at vendoring time, whose output is committed.
   It is not a build step for running the app — there is still none of those.

2. **The extension was `.mjs`, and is now `.js`.** Python's `mimetypes` has no
   entry for `.mjs`, so both `StaticFiles` (backend) and `serve.py` hand it back
   as `text/plain` — and a browser refuses to `import()` a module with a non-JS
   MIME type. Renaming beats teaching two servers a new extension.
3. **The worker is constructed from this directory, never from a Blob URL.**
   The usual DuckDB recipe wraps the worker script in a Blob, which would force
   `worker-src blob:` into the Content-Security-Policy. `frontend/sandbox.js`
   uses a plain same-origin URL instead, so `default-src 'self'` covers it, and
   `backend/tests/test_contract_conformance.py` asserts the header never grows
   a `blob:`.

## Upgrading

Do the bundling in a scratch directory, then copy three files in. Do not run
`npm install` into this tree — there is no build step and no `node_modules`
here, on purpose.

```bash
# in a scratch dir
npm install esbuild @duckdb/duckdb-wasm@<VER>
echo "export * from '@duckdb/duckdb-wasm/dist/duckdb-browser.mjs';" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser \
    --outfile=duckdb-browser.js --legal-comments=none --minify
cp duckdb-browser.js                                     <here>/
cp node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm  <here>/
cp node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js <here>/
```

npm's `latest` tag on this package is usually a `-dev` build; pick the newest
plain `x.y.z` version instead.

**Then run the browser check** — `backend/tests/ops_browser.py`. Every one of
the three problems above (bare import, MIME type, blob worker) is invisible to
`pytest` and to `node --check`: they only appear in a real browser. That
harness is the only thing standing between a version bump and a silently dead
tab.

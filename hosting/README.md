# Hosting ecmaOS

ecmaOS runs programs in Web Workers that wait on a `SharedArrayBuffer`. A browser gives that to a page only when it is
**cross-origin isolated**, which means every response for the page carries two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and the page is a secure context (`https://`, or `localhost`). If they are missing, the kernel stops at boot and prints
these same instructions.

Build the site with `pnpm build --filter @ecmaos/kernel`; the files to serve are in `core/kernel/dist`. The build needs
Node and pnpm only: no C or WebAssembly toolchain, because every program ships prebuilt. The one native dependency is the
`canvas` package; on a host with no prebuilt binary for it (Amazon Linux, as on Vercel) install `gcc-c++`, `cairo-devel`,
`pango-devel`, `libjpeg-turbo-devel` and `giflib-devel` first. GitHub's `ubuntu-latest` runners need nothing extra.

| Host | File here | Notes |
|---|---|---|
| `ecmaos --serve` | none | Serves the build with the headers set: `npx ecmaos --serve --site core/kernel/dist` |
| Cloudflare Workers | `cloudflare/` | Static assets over `core/kernel/dist`, set up with `cf`; the primary target |
| Netlify | `netlify.toml` | Set the configuration file path to `hosting/netlify.toml` |
| Vercel | `vercel.json` | Community target; import the repository and set the configuration file path |
| Other static hosts | `_headers` | Copy it into the published folder; Cloudflare Pages and Netlify read it |
| nginx | `nginx.conf` | A `server` block |
| Caddy | `Caddyfile` | |
| Apache | `apache.conf` | Needs `mod_headers` |
| Docker | `Dockerfile` | nginx with the configuration above |
| GitHub Pages | none | It cannot set response headers, so it cannot host ecmaOS |

## Cloudflare

`hosting/cloudflare` is a Worker with no code: Workers static assets serve `core/kernel/dist` and apply its `_headers`
file. It is not part of the pnpm workspace; it has its own `package.json` with `cf`.

```sh
pnpm build --filter @ecmaos/kernel
cd hosting/cloudflare
npm install
npm run dev      # cf dev, at http://localhost:8787
npm run deploy   # cf deploy
```

Both scripts first copy `hosting/_headers` into `core/kernel/dist`. Sign in once with `cf login`, or set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Limits (Workers Free): 20,000 files per version and 25 MiB per file;
the site is about 2,400 files and its largest file is under 20 MiB. Re-check both when the build grows.

`.github/workflows/deploy-cloudflare.yml` builds and deploys on a `v*` tag, or by hand from the Actions tab. Its two
secrets, `CLOUDFLARE_API_TOKEN` (permission Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID`, are set in the
repository settings; they are not stored anywhere else. A custom domain is attached in the Cloudflare dashboard.

## Add a target

1. Build the site, then make the host serve `core/kernel/dist` with the three rules below.
2. Put its configuration in `hosting/` and add it to the table above.
3. Add its checks to `check.mjs`. `node hosting/check.mjs` reads every file here; `node hosting/check.mjs --serve` also
   starts nginx, Caddy and Apache in Docker over a small site and checks the real response headers.

The rules, for every target:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response.
- `.wasm` as `application/wasm`.
- `.gz` as `application/octet-stream`, with no `Content-Encoding`.

## After deploying

1. Open the site. The kernel boots to a login prompt instead of the isolation instructions.
2. In the browser console, `crossOriginIsolated` is `true`.
3. Log in and run a program, a WebAssembly one among them.
4. In the network tab, `initfs.tar.gz` has no `Content-Encoding` header.

## What the isolation costs

- Every cross-origin resource the page loads (fonts, images, scripts, frames) must send a
  `Cross-Origin-Resource-Policy` or CORS header, or the browser blocks it.
- A popup opened with `window.open` loses its link to the page that opened it (OAuth popups, for example).
- Another site cannot embed ecmaOS in a frame unless that site is isolated too.

## Files to serve as they are

`initfs.tar.gz` and the `.gz` programs are already compressed. Serve them as `application/octet-stream` with no
`Content-Encoding`, or the browser unpacks them before the kernel does. Serve `.wasm` as `application/wasm`.

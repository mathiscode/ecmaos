# Hosting ecmaOS

ecmaOS runs programs in Web Workers that wait on a `SharedArrayBuffer`. A browser gives that to a page only when it is
**cross-origin isolated**, which means every response for the page carries two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and the page is a secure context (`https://`, or `localhost`). If they are missing, the kernel stops at boot and prints
these same instructions.

Build the site with `pnpm build --filter @ecmaos/kernel`; the files to serve are in `core/kernel/dist`.

| Host | File here | Notes |
|---|---|---|
| `ecmaos --serve` | none | Serves the build with the headers set: `npx ecmaos --serve --site core/kernel/dist` |
| Vercel | `/vercel.json` at the repo root | Already configured |
| Netlify, Cloudflare Pages | `_headers` | Copy it into the published folder. Cloudflare Pages reads the same file |
| nginx | `nginx.conf` | A `server` block |
| Caddy | `Caddyfile` | |
| Apache | `apache.conf` | Needs `mod_headers` |
| Docker | `Dockerfile` | nginx with the configuration above |
| GitHub Pages | none | It cannot set response headers, so it cannot host ecmaOS |

## What the isolation costs

- Every cross-origin resource the page loads (fonts, images, scripts, frames) must send a
  `Cross-Origin-Resource-Policy` or CORS header, or the browser blocks it.
- A popup opened with `window.open` loses its link to the page that opened it (OAuth popups, for example).
- Another site cannot embed ecmaOS in a frame unless that site is isolated too.

## Files to serve as they are

`initfs.tar.gz` and the `.gz` programs are already compressed. Serve them as `application/octet-stream` with no
`Content-Encoding`, or the browser unpacks them before the kernel does. Serve `.wasm` as `application/wasm`.

# hosting

`man @ecmaos/coreutils/hosting`

## Description

ecmaOS runs programs in Web Workers that wait on a `SharedArrayBuffer`, which a browser gives only to a page that is
cross-origin isolated. Serve every response with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and serve the page over `https://` (or from `localhost`). If the page is not isolated, the kernel stops at boot and says so.

The quickest way to serve a build is `ecmaos --serve`, which sets the headers itself. The `hosting/` folder of the source
holds ready-made configuration for Netlify, Cloudflare Pages, nginx, Caddy, Apache and Docker. GitHub Pages cannot set
response headers and cannot host ecmaOS.

## Notes

- Every cross-origin resource the page loads must send a `Cross-Origin-Resource-Policy` or CORS header.
- A popup opened with `window.open` loses its link to the opener.
- Serve `.gz` files as `application/octet-stream` with no `Content-Encoding`, and `.wasm` as `application/wasm`.

## See also

`man @ecmaos/coreutils/inittab`

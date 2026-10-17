/**
 * The two halves of a display-side app window, as text a display page can use: `frameScript` runs in the app's sandboxed
 * frame and builds the `AppSdk`; `relayScript` runs in the display page, mounts the frame and forwards its calls to the
 * machine. Every display (the loopback page of a Node host, a screen logged in over the peer link) uses the same two.
 */

import frameScript from './display-sandbox/frame.js?raw'
import relayScript from './display-sandbox/relay.js?raw'

export { frameScript, relayScript }

/** The document the app's frame is loaded with */
export const frameDocument = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style><body><script>${frameScript}</script></body>`

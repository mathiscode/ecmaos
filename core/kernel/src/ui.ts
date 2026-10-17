import { displayRequest, runDisplay } from '#lib/display-client.ts'
import { runScreen, screenRequest } from '#lib/screen.ts'

// A page address with `?display=N` is only a display of another tab's machine; anything else boots a kernel
// `?screen=HOST` is a screen of a machine running somewhere else (`ecmaos --listen`): it boots no kernel either
const screen = screenRequest(globalThis.location?.search ?? '')
const display = displayRequest(globalThis.location?.search ?? '')
if (screen) void runScreen(screen)
else if (display) void runDisplay(display)
else void import('./boot.ts')

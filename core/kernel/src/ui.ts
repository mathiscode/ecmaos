import { displayRequest, runDisplay } from '#lib/display-client.ts'

// A page address with `?display=N` is only a display of another tab's machine; anything else boots a kernel
const display = displayRequest(globalThis.location?.search ?? '')
if (display) void runDisplay(display)
else void import('./boot.ts')

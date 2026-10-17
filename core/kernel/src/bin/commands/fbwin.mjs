/** Open a window with a framebuffer device that draws in it. */

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, stat, custom } = syscalls

const usage = `Usage: fbwin [-t TITLE] [WIDTHxHEIGHT]
Open a window of WIDTHxHEIGHT pixels (default 640x480) and print the framebuffer device that draws in it,
such as /dev/fb0. Pixels are 32 bits, blue first. The window and the device go when this command ends or
the window is closed.

  -t, --title TITLE     the window's title
  --help                display this help and exit`

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text + '\n'))
const fail = text => { write(2, encoder.encode(`fbwin: ${text}\n`)); return 1 }
const errors = { 22: 'a framebuffer is 1 to 4096 pixels each way', 28: 'no free framebuffer', 19: 'windows are not available here' }

async function main() {
  const args = argv.slice(1)
  let title = ''
  let size = '640x480'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { out(usage); return 0 }
    if (arg === '-t' || arg === '--title') { title = args[++i] ?? ''; continue }
    if (arg.startsWith('-')) return fail(`invalid option '${arg}'. Try 'fbwin --help'`)
    size = arg
  }
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return fail(`'${size}' is not a size (use WIDTHxHEIGHT)`)

  let index
  try {
    index = await custom('fb_create', Number(match[1]), Number(match[2]), title)
  } catch (error) {
    return fail(errors[error?.errno] ?? (error instanceof Error ? error.message : String(error)))
  }
  const path = `/dev/fb${index}`
  out(path)

  // the window ends this command when the user closes it
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 250))
    try { stat(path) } catch { return 0 }
  }
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`fbwin: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}

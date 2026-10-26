/** Whether a terminal takes messages: the write bits other than the owner's on its device, which `mesg` sets and `write` and `wall` obey. */

const { stat, getuid } = globalThis.ecmaosSyscalls

/** The device of a login line from `/run/utmp` (`tty1`) */
export const deviceOf = line => `/dev/xterm${String(line).replace(/^tty/, '')}`

/** The group and other write bits: both are set when messages are allowed (the device starts at 0666) */
export const MESSAGE_BITS = 0o022

export const acceptsMessages = device => { try { return (stat(device).mode & MESSAGE_BITS) !== 0 } catch { return true } }

/** root writes to a terminal whatever its owner chose, as on Linux */
export const mayWrite = device => getuid() === 0 || acceptsMessages(device)

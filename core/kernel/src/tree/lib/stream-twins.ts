/**
 * Output streams that write to the same place and must stay in the order the program wrote them (`> f 2>&1`,
 * `&> f`). The shell registers a program's stderr stream against its stdout stream; the kernel then gives the
 * program one pipe for both descriptors, since two pipes each polled on its own lose the order between them.
 */
const twins = new WeakMap<object, object>()

export function pairStreams(stdout: object, stderr: object): void {
  twins.set(stderr, stdout)
}

/** True when `stderr` was registered as the other half of `stdout`, or is the very same stream. */
export function sharesDestination(stdout: object | undefined, stderr: object | undefined): boolean {
  return Boolean(stdout && stderr && (stdout === stderr || twins.get(stderr) === stdout))
}

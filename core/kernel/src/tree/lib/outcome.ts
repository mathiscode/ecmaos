/**
 * What a main-thread syscall that does a whole command's work reports back to its program: the
 * lines to print (a syscall can only return a number, so the messages travel in the scratch file)
 * and the exit code.
 */
export interface OutcomeLine { stream: 'out' | 'err', text: string }
export interface Outcome { code: number, lines: OutcomeLine[] }

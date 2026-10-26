/**
 * The files under `/etc` a Linux machine has and a program or a person looks for. Each is written only when missing, so
 * what an administrator edits stays.
 */

export const DEFAULT_FSTAB = [
  '# /etc/fstab: what `mount -a` mounts at boot, one entry per line.',
  '#',
  '# <source>  <target>  <type>  <options>',
  '#',
  '# Types are those of /proc/filesystems. A type that needs no source takes `none`, for example:',
  '#   none  /scratch  memory  defaults',
  ''
].join('\n')

export const DEFAULT_ENVIRONMENT = [
  '# /etc/environment: variables every login shell starts with, one NAME=value per line.',
  '# There is no expansion and no `export`; quotes around a value are removed.',
  ''
].join('\n')

/** `\n` host name, `\l` terminal, `\r` release, `\s` system, `\m` machine; getty expands them, as agetty does */
export const DEFAULT_ISSUE = 'ecmaOS \\r (\\l)\n'

/** 32 lowercase hexadecimal digits and a newline, as systemd writes `/etc/machine-id` */
export function newMachineId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') + '\n'
}

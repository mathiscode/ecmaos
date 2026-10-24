/**
 * Nodes made at runtime on a major the kernel registered at boot (a pixel window's input device on the input major). The
 * kernel's dispatcher for the major looks here when no boot-time driver has the minor.
 */
import type { FileOperations } from '@zenfs/linux'

const minors = new Map<string, FileOperations>()
const key = (major: number, minor: number) => `${major}:${minor}`

export function registerMinor(major: number, minor: number, ops: FileOperations): () => void {
  minors.set(key(major, minor), ops)
  return () => { minors.delete(key(major, minor)) }
}

export const dynamicMinor = (major: number, minor: number): FileOperations | undefined => minors.get(key(major, minor))

/** Whether a node made at runtime on `major` answers ioctl `request`, so the major's dispatcher offers it */
export function dynamicIoctl(major: number, request: PropertyKey): boolean {
  for (const [at, ops] of minors) if (at.startsWith(`${major}:`) && ops.ioctl && request in ops.ioctl) return true
  return false
}

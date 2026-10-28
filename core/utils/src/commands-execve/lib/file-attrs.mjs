/**
 * The file attributes `chattr` sets and `lsattr` shows: e2fsprogs's letters and names for the `FS_*_FL` bits, in the
 * order `lsattr` prints them, and the `FS_IOC_GETFLAGS`/`FS_IOC_SETFLAGS` ioctls that read and write them.
 */

const { ioctl } = globalThis.ecmaosSyscalls

export const GETFLAGS = 0x80086601
export const SETFLAGS = 0x40086602

/** `[bit, letter, long name]`, in e2fsprogs's order */
export const ATTRIBUTES = [
  [0x1, 's', 'Secure_Deletion'], [0x2, 'u', 'Undelete'], [0x8, 'S', 'Synchronous_Updates'],
  [0x10000, 'D', 'Synchronous_Directory_Updates'], [0x10, 'i', 'Immutable'], [0x20, 'a', 'Append_Only'],
  [0x40, 'd', 'No_Dump'], [0x80, 'A', 'No_Atime'], [0x4, 'c', 'Compression_Requested'], [0x800, 'E', 'Encrypted'],
  [0x4000, 'j', 'Journaled_Data'], [0x1000, 'I', 'Indexed_directory'], [0x8000, 't', 'No_Tailmerging'],
  [0x20000, 'T', 'Top_of_Directory_Hierarchies'], [0x80000, 'e', 'Extents'], [0x800000, 'C', 'No_COW'],
  [0x2000000, 'x', 'DAX'], [0x40000000, 'F', 'Casefold'], [0x10000000, 'N', 'Inline_Data'],
  [0x20000000, 'P', 'Project_Hierarchy'], [0x100000, 'V', 'Verity'], [0x400, 'm', 'Dont_Compress']
]

/** The bit of an attribute letter, or undefined */
export const bitOf = letter => ATTRIBUTES.find(([, l]) => l === letter)?.[0]

/** `lsattr`'s short form: a letter for each attribute set, `-` for each that is not */
export const shortForm = flags => ATTRIBUTES.map(([bit, letter]) => flags & bit ? letter : '-').join('')

/** `lsattr -l`'s long form: the names of the attributes set, or `---` */
export const longForm = flags => ATTRIBUTES.filter(([bit]) => flags & bit).map(([, , name]) => name).join(', ') || '---'

export const getFlags = fd => ioctl(fd, GETFLAGS) >>> 0
export const setFlags = (fd, flags) => ioctl(fd, SETFLAGS, flags >>> 0)

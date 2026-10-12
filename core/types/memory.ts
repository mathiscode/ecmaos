/**
 * Memory methods for niche use and experiments. A heap address holds an arbitrary number of bytes and indexes a
 * Uint8Array.
 *
 * @example
 * # Heap
 * const address = kernel.memory.allocate(1024);
 * kernel.memory.write(address, new Uint8Array(1024).fill(1));
 * const value = kernel.memory.read(address)
 *
 * # Stack
 * kernel.memory.push(value)
 * kernel.memory.peek()
 * kernel.memory.pop()
 */

/** Memory address type */
export type Address = number

/** Collection type for storing arbitrary data */
export type Collection<T = unknown> = Set<T>

/** Configuration type for storing key-value pairs */
export type Config<T = unknown> = Map<string, T>

/** Heap type for storing memory blocks */
export type Heap<T = Uint8Array> = Map<Address, T>

/** Stack type for storing frames */
export type Stack<T = unknown> = Array<StackFrame<T>>

/** Stack frame type for storing data */
export type StackFrame<T = unknown> = Record<string, T>

/**
 * Interface for memory management functionality
 */
export interface Memory {
  /** Configuration storage */
  readonly config: Config
  /** Collection storage */
  readonly collection: Collection
  /** Heap storage */
  readonly heap: Heap
  /** Stack storage */
  readonly stack: Stack

  /**
   * Push a value onto the stack
   * @param value - Value to push
   */
  push(value: StackFrame): void

  /**
   * Pop a value from the stack
   */
  pop(): StackFrame | undefined

  /**
   * Peek at the top value on the stack
   */
  peek(): StackFrame | undefined

  /**
   * Allocate memory on the heap
   * @param size - Size in bytes to allocate
   */
  allocate(size: number): Address

  /**
   * Free memory from the heap
   * @param address - Address to free
   */
  free(address: Address): void

  /**
   * Read memory from the heap
   * @param address - Address to read from
   */
  read(address: Address): Uint8Array | undefined

  /**
   * Write memory to the heap
   * @param address - Address to write to
   * @param value - Data to write
   */
  write(address: Address, value: Uint8Array): void

  /**
   * Copy memory between addresses
   * @param source - Source address
   * @param destination - Destination address
   */
  copy(source: Address, destination: Address): void

  /**
   * Move memory between addresses
   * @param source - Source address
   * @param destination - Destination address
   */
  move(source: Address, destination: Address): void

  /**
   * Compare memory at two addresses
   * @param address1 - First address
   * @param address2 - Second address
   */
  compare(address1: Address, address2: Address): boolean

  /**
   * Search for a pattern in memory
   * @param value - Pattern to search for
   */
  search(value: Uint8Array): number
} 
/**
 * Logging types and interfaces
 */

import type { ILogObj, ILogObjMeta, ISettingsParam, Logger } from 'tslog'

/**
 * Options for configuring logging
 */
export interface LogOptions {
  /** Name of the logger */
  name?: string
  /** Whether to silence all logging */
  silent?: boolean
  /** Type of logging output */
  type?: 'hidden' | 'json' | 'pretty'
}

/**
 * Interface for logging functionality
 */
export interface Log extends Logger<ILogObj> {
  /** Get logger name */
  readonly name: string

  /**
   * Attach a transport for log output
   * @param transportLogger - Transport function
   * @returns Function that detaches the transport
   */
  attachTransport(transportLogger: (logObj: ILogObj & ILogObjMeta) => void): () => void

  /** Log at silly level */
  silly(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at trace level */
  trace(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at debug level */
  debug(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at info level */
  info(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at warn level */
  warn(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at error level */
  error(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined

  /** Log at fatal level */
  fatal(...args: unknown[]): (ILogObj & ILogObjMeta) | undefined
} 
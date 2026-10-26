import { ILogObj, Logger } from 'tslog'

import type { Log as ILog, LogOptions } from '@ecmaos/types'

export const DefaultLogOptions: LogOptions = {
  type: 'pretty'
}

export class Log extends Logger<ILogObj> implements ILog {
  private _name: string

  get name() { return this._name }

  constructor(_options: LogOptions = DefaultLogOptions) {
    const options = { ...DefaultLogOptions, ..._options }

    const icons: Record<string, string> = { DEBUG: '🔍', INFO: '💡', WARN: '⚠️', ERROR: '🚨', FATAL: '💀' }

    super({
      name: options.name || 'ecmaos:kernel',
      type: options.type || 'pretty',
      // tslog 5 masks nothing by default; 4 masked "password"
      mask: { keys: ['password'], caseInsensitive: true },
      stack: { capture: 'off' },
      // the kernel's transports read the metadata from _meta, where tslog 4 put it
      meta: { property: '_meta' },
      pretty: {
        errorTemplate: '{{errorName}} {{errorMessage}} {{errorStack}}',
        template: '{{dateIsoStr}} {{name}} {{logLevelName}}\t {{icon}}\t ',
        placeholders: {
          /* v8 ignore next */
          icon: meta => icons[meta.logLevelName] ?? '💬'
        }
      }
    })

    this._name = options.name || 'ecmaos:kernel'

    /* v8 ignore start */
    if (options.silent) {
      this.silly = () => undefined
      this.debug = () => undefined
      this.info = () => undefined
      this.warn = () => undefined
      this.error = () => undefined
      this.fatal = () => undefined
    }
    /* v8 ignore end */
  }
}

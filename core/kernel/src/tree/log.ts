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

    super({
      name: options.name || 'ecmaos:kernel',
      type: options.type || 'pretty',
      maskValuesOfKeysCaseInsensitive: true,
      hideLogPositionForProduction: true,
      prettyErrorTemplate: '{{errorName}} {{errorMessage}} {{errorStack}}',
      overwrite: {
        /* v8 ignore start */
        addPlaceholders: (logObjMeta, placeholderValues) => {
          switch (logObjMeta.logLevelName) {
            case 'DEBUG':
              placeholderValues.icon = '🔍'
              break
            case 'INFO':
              placeholderValues.icon = '💡'
              break
            case 'WARN':
              placeholderValues.icon = '⚠️'
              break
            case 'ERROR':
              placeholderValues.icon = '🚨'
              break
            case 'FATAL':
              placeholderValues.icon = '💀'
              break
            default:
              placeholderValues.icon = '💬'
              break
          }
        }
        /* v8 ignore end */
      }
    })

    // Set after construction: tslog warns about any placeholder it does not know, including the ones addPlaceholders adds
    this.settings.prettyLogTemplate = '{{dateIsoStr}} {{name}} {{logLevelName}}\t {{icon}}\t '

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

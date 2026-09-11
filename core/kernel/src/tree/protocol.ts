import type { ProtocolOptions, ProtocolWiring, Terminal } from '@ecmaos/types'

export class Protocol {
  private _terminal?: Terminal

  constructor(options: ProtocolOptions) {
    globalThis.navigator?.registerProtocolHandler?.(
      import.meta.env.ECMAOS_APP_PROTOCOL || options.schema || 'web+ecmaos',
      `${import.meta.env.ECMAOS_APP_URL || window.location.origin}?protocol=%s`
    )
  }

  wire(wiring: ProtocolWiring) {
    this._terminal = wiring.terminal
  }

  open(uri: string) {
    if (!this._terminal) throw new Error('Protocol.open() called before wire()')
    this._terminal.writeln(`Opening ${uri}`)
  }
}

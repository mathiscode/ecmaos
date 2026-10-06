import type { Components as IComponents, ComponentListener } from '@ecmaos/types'

/**
 * The Components (plural) class provides a registry for custom elements (Web Components) within the kernel.
 * 
 */
export class Components implements IComponents {
  private _components: Map<string, CustomElementConstructor> = new Map()

  get components() { return this._components }
  get names() { return Array.from(this._components.keys()) }

  define(name: string, component: CustomElementConstructor) {
    this._components.set(name, component)
    return globalThis.customElements.define(name, component)
  }

  get(name: string) {
    return this._components.get(name)
  }

  getName(component: CustomElementConstructor) {
    return globalThis.customElements.getName(component)
  }

  has(name: string) {
    return this._components.has(name)
  }

  upgrade(root: Node) {
    return globalThis.customElements.upgrade(root)
  }

  whenDefined(name: string) {
    return globalThis.customElements.whenDefined(name)
  }
}

/**
 * The Component (singular) class extends the HTMLElement class to provide a base class for custom elements.
 * 
 */
export class Component extends ((globalThis.HTMLElement ?? class {}) as typeof HTMLElement) {
  static observedAttributes = ['data']

  private _data: unknown
  private _listeners: Map<string, Set<ComponentListener>> = new Map()

  get data() { return this._data }
  get listeners() { return this._listeners }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = `<h1>Hello World</h1>`
  }

  adoptedCallback() {
    for (const listener of this._listeners.get('adopted') || []) listener(this)
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (name === 'data') this._data = newValue
    for (const listener of this._listeners.get('attributeChanged') || []) listener(name, oldValue, newValue)
  }

  connectedCallback() {
    for (const listener of this._listeners.get('connected') || []) listener(this)
  }

  disconnectedCallback() {
    for (const listener of this._listeners.get('disconnected') || []) listener(this)
  }
}

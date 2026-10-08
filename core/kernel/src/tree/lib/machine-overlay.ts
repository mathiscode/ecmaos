/** A plain full-page notice with buttons, for the moments the machine is not this tab's to run (see `machine-lock.ts`) */
/** `field` adds a text box (starting with that text) whose content `run` receives */
export interface OverlayAction { label: string, run(value: string): void, field?: string }

export function showOverlay(title: string, lines: string[], actions: OverlayAction[]): { close(): void } {
  const document = globalThis.document
  if (!document) return { close() {} }
  const root = document.createElement('div')
  root.setAttribute('role', 'alertdialog')
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.82);color:#e6e6e6;font:15px/1.5 system-ui,sans-serif;padding:16px'
  const box = document.createElement('div')
  box.style.cssText = 'max-width:30rem;background:#161616;border:1px solid #333;border-radius:8px;padding:20px 24px'
  const heading = document.createElement('h2')
  heading.textContent = title
  heading.style.cssText = 'margin:0 0 .5rem;font-size:1.15rem'
  box.append(heading)
  for (const line of lines) {
    const paragraph = document.createElement('p')
    paragraph.textContent = line
    paragraph.style.cssText = 'margin:.4rem 0'
    box.append(paragraph)
  }
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap'
  for (const action of actions) {
    let input: HTMLInputElement | undefined
    if (action.field !== undefined) {
      input = document.createElement('input')
      input.value = action.field
      input.spellcheck = false
      input.style.cssText = 'padding:.4rem .6rem;border-radius:6px;border:1px solid #555;background:#0e0e0e;color:inherit;font:inherit;width:11rem'
      row.append(input)
    }
    const button = document.createElement('button')
    button.textContent = action.label
    button.style.cssText = 'cursor:pointer;padding:.45rem .9rem;border-radius:6px;border:1px solid #555;background:#262626;color:inherit;font:inherit'
    button.addEventListener('click', () => action.run(input?.value.trim() ?? ''))
    row.append(button)
  }
  box.append(row)
  root.append(box)
  document.body.append(root)
  return { close() { root.remove() } }
}

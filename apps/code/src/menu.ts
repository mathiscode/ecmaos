import type * as monaco from 'monaco-editor'

export interface MenuActions {
  save(): Promise<void>
  exit(): void
}

/** The editor's menu bar; what Save and Exit do belongs to the host the editor runs in (the kernel's page, or a display's sandbox) */
export const createMenuBar = (editor: monaco.editor.IStandaloneCodeEditor, actions: MenuActions) => {
  const menuBar = document.createElement('div')
  menuBar.style.cssText = `
    width: 100%;
    height: 30px;
    background: #252526;
    display: flex;
    align-items: center;
    padding: 0 8px;
    border-bottom: 1px solid #3c3c3c;
  `

  // Track active dropdown to close it when clicking elsewhere
  let activeDropdown: HTMLElement | null = null
  document.addEventListener('click', (e) => {
    if (activeDropdown && !activeDropdown.contains(e.target as Node)) {
      activeDropdown.style.display = 'none'
      activeDropdown = null
    }
  })

  const createMenuItem = (text: string, items: { label: string, action?: () => Promise<void> | void }[]) => {
    const menuItemContainer = document.createElement('div')
    menuItemContainer.style.position = 'relative'
    
    const menuItem = document.createElement('div')
    menuItem.textContent = text
    menuItem.style.cssText = `
      color: #cccccc;
      padding: 0 8px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      height: 30px;
      line-height: 30px;
    `
    
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: absolute;
      top: 100%;
      left: 0;
      background: #252526;
      border: 1px solid #3c3c3c;
      display: none;
      min-width: 180px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      z-index: 1000;
    `

    items.forEach(item => {
      if (item.label === '-') {
        const separator = document.createElement('div')
        separator.style.cssText = 'height: 1px; background: #3c3c3c; margin: 4px 0;'
        dropdown.appendChild(separator)
        return
      }

      const dropdownItem = document.createElement('div')
      dropdownItem.textContent = item.label
      dropdownItem.style.cssText = `
        padding: 6px 12px;
        cursor: pointer;
        color: #cccccc;
        font-size: 13px;
      `

      dropdownItem.addEventListener('mouseenter', () => dropdownItem.style.background = '#37373d')
      dropdownItem.addEventListener('mouseleave', () => dropdownItem.style.background = 'transparent')

      if (item.action) {
        dropdownItem.addEventListener('click', async () => {
          await item.action?.()
          dropdown.style.display = 'none'
          activeDropdown = null
        })
      }
      
      dropdown.appendChild(dropdownItem)
    })

    menuItem.addEventListener('click', (e) => {
      e.stopPropagation()
      if (activeDropdown && activeDropdown !== dropdown) {
        activeDropdown.style.display = 'none'
      }
      const isVisible = dropdown.style.display === 'block'
      dropdown.style.display = isVisible ? 'none' : 'block'
      activeDropdown = isVisible ? null : dropdown
    })

    menuItem.addEventListener('mouseenter', () => menuItem.style.background = '#37373d')
    menuItem.addEventListener('mouseleave', () => menuItem.style.background = 'transparent')

    menuItemContainer.appendChild(menuItem)
    menuItemContainer.appendChild(dropdown)
    return menuItemContainer
  }

  const fileMenu = createMenuItem('File', [
    {
      label: 'Save',
      action: () => actions.save()
    },
    { label: '-' },
    {
      label: 'Exit',
      action: () => actions.exit()
    }
  ])

  const editMenu = createMenuItem('Edit', [
    {
      label: 'Undo',
      action: () => editor.trigger('menu', 'undo', null)
    },
    {
      label: 'Redo',
      action: () => editor.trigger('menu', 'redo', null)
    },
    { label: '-' },
    {
      label: 'Cut',
      action: () => editor.trigger('menu', 'cut', null)
    },
    {
      label: 'Copy',
      action: () => editor.trigger('menu', 'copy', null)
    },
    {
      // Paste through the editor trigger may be refused by the browser
      label: 'Paste',
      action: () => editor.trigger('source', 'paste', null)
    }
  ])

  menuBar.appendChild(fileMenu)
  menuBar.appendChild(editMenu)
  return menuBar
}

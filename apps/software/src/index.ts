import type { ProcessEntryParams } from '@ecmaos/types'

import { Software, installCommand, reason, removeCommand } from './model.js'
import type { Category, Detail, InstalledRow, Result, Row, Run, Scope } from './model.js'

const css = `
.sw { display: flex; flex-direction: column; height: 100%; font: 14px system-ui, sans-serif; color: #e8e8e8; background: #14171f; }
.sw * { box-sizing: border-box; }
.sw .bar { display: flex; gap: 4px; padding: 6px; border-bottom: 1px solid #2c3140; align-items: center; }
.sw button { font: inherit; color: inherit; background: #232838; border: 1px solid #343b50; border-radius: 4px; padding: 4px 10px; cursor: pointer; width: auto; min-width: 0; margin: 0; }
.sw button:hover:not(:disabled) { background: #2d3449; }
.sw button:disabled { opacity: .5; cursor: default; }
.sw button.on { background: #3a4668; border-color: #5b6aa0; }
.sw input { font: inherit; color: inherit; background: #0f1218; border: 1px solid #343b50; border-radius: 4px; padding: 4px 8px; }
.sw .bar input[type=search] { flex: 1; min-width: 0; }
.sw .body { flex: 1; display: flex; min-height: 0; }
.sw .list { width: 42%; min-width: 220px; overflow: auto; border-right: 1px solid #2c3140; }
.sw .detail { flex: 1; overflow: auto; padding: 12px 16px; }
.sw h3 { margin: 10px 8px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.sw .item { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent; padding: 6px 10px; }
.sw .item.sel { background: #3a4668; }
.sw .item small { display: block; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw .tag { font-size: 11px; opacity: .8; border: 1px solid #343b50; border-radius: 8px; padding: 0 6px; margin-left: 6px; }
.sw .note { padding: 8px 12px; background: #3b2f12; border-bottom: 1px solid #5c4a1c; font-size: 13px; }
.sw .error { color: #ff8a80; margin: 8px 0; white-space: pre-wrap; }
.sw dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0; }
.sw dt { opacity: .65; }
.sw dd { margin: 0; overflow-wrap: anywhere; }
.sw .actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; align-items: center; }
.sw .status { opacity: .75; padding: 8px 12px; }
`

type Tab = 'explore' | 'installed' | 'updates' | 'npm'
const TABS: [Tab, string][] = [['explore', 'Explore'], ['installed', 'Installed'], ['updates', 'Updates'], ['npm', 'More on npm']]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) node.className = className
  Object.assign(node, rest)
  for (const child of children) node.append(child)
  return node
}

const size = (bytes?: number) => (bytes ? (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`) : '')

const main = async (params: ProcessEntryParams) => {
  const { kernel, shell, instance, uid, pid } = params
  const fs = shell.context.fs.promises
  const root = uid === 0

  // one command at a time on the shell, each with its output in files only this window reads
  let queue: Promise<unknown> = Promise.resolve()
  let counter = 0
  const run: Run = command => {
    const task = queue.then(async (): Promise<Result> => {
      const base = `/tmp/.software-${pid}-${counter++}`
      const code = await shell.execute(`${command} > ${base}.out 2> ${base}.err`)
      const read = async (suffix: string) => { try { return String(await fs.readFile(`${base}${suffix}`, 'utf8')) } catch { return '' } finally { await fs.unlink(`${base}${suffix}`).catch(() => {}) } }
      return { code: Number(code), out: await read('.out'), err: await read('.err') }
    })
    queue = task.catch(() => {})
    return task
  }
  const software = new Software(run)

  const style = el('style', { textContent: css })
  const root_ = el('div', { class: 'sw' })
  const bar = el('div', { class: 'bar' })
  const search = el('input', { type: 'search', placeholder: 'Search the index', ariaLabel: 'Search' })
  const body = el('div', { class: 'body' })
  const list = el('div', { class: 'list' })
  const detail = el('div', { class: 'detail' })
  const notice = el('div', { class: 'note', hidden: true, textContent: 'Results from npm are not curated by ecmaOS: anyone can publish them, and a package can run code on your machine. Look at the maintainer and date before you install.' })
  body.append(list, detail)
  root_.append(style, bar, notice, body)

  let tab: Tab = 'explore'
  let selected: string | undefined
  const tabButtons = new Map<Tab, HTMLButtonElement>()

  const status = (text: string, error = false) => { list.replaceChildren(el('div', { class: error ? 'status error' : 'status', textContent: text })) }
  const item = (name: string, subtitle: string, packageName: string, tag?: string) => {
    const button = el('button', { class: `item${packageName === selected ? ' sel' : ''}` }, el('span', { textContent: name }), ...(tag ? [el('span', { class: 'tag', textContent: tag })] : []), el('small', { textContent: subtitle }))
    button.addEventListener('click', () => { selected = packageName; void showDetail(packageName); for (const other of list.querySelectorAll('.item')) other.classList.remove('sel'); button.classList.add('sel') })
    return button
  }

  async function showDetail(name: string) {
    detail.replaceChildren(el('div', { class: 'status', textContent: 'Loading...' }))
    let info: Detail
    try { info = await software.show(name) } catch (error) { detail.replaceChildren(el('div', { class: 'error', textContent: error instanceof Error ? error.message : String(error) })); return }
    const rows: [string, string][] = [
      ['Installed', info.installed ? `${info.installed.version}, ${info.installed.explicit ? 'asked for by name' : 'as a dependency'}, for ${info.installed.everyone ? 'everyone' : 'you'}${info.latest && info.latest !== info.installed.version ? `; ${info.latest} is available` : ''}` : 'no'],
      ['Kind', info.kind === 'wasm' ? 'Program (WebAssembly)' : info.kind === 'app' ? 'App with a window' : info.kind === 'collection' ? 'Collection of programs' : 'Package'],
      ['Size', size(info.size)], ['License', info.license ?? ''], ['Homepage', info.homepage ?? ''],
      ['Collections', info.collections.join(', ') + (info.profiles.length ? ` (in ${info.profiles.join(', ')})` : '')],
      ['Depends on', info.dependencies.join(', ')],
      ['Source', info.source ? `apt source ${info.command ?? info.name}` : ''],
      ['Deprecated', info.deprecated ?? '']
    ]
    const facts = el('dl')
    for (const [term, value] of rows) if (value) facts.append(el('dt', { textContent: term }), el('dd', { textContent: value }))
    const message = el('div', { class: 'error' })
    const actions = el('div', { class: 'actions' })
    const act = async (label: string, work: () => Promise<Result>) => {
      for (const button of actions.querySelectorAll('button')) button.disabled = true
      message.className = 'status'
      message.textContent = `${label}...`
      try {
        const result = await work()
        if (result.code !== 0) { message.className = 'error'; message.textContent = reason(result); for (const button of actions.querySelectorAll('button')) button.disabled = false; return }
        kernel.dom.toast.success(`${info.name}: done`)
        await refresh()
        await showDetail(name)
      } catch (error) {
        message.className = 'error'
        message.textContent = error instanceof Error ? error.message : String(error)
        for (const button of actions.querySelectorAll('button')) button.disabled = false
      }
    }
    // the password is written to a file only this user can read, for one command, then removed
    const withPassword = async (work: (file: string) => Promise<Result>): Promise<Result> => {
      const password = await askPassword()
      if (password === undefined) return { code: 1, out: '', err: 'cancelled' }
      const file = `/tmp/.software-pw-${pid}-${counter++}`
      await fs.writeFile(file, `${password}\n`, { mode: 0o600 })
      try { return await work(file) } finally { await fs.unlink(file).catch(() => {}) }
    }
    const askPassword = () => new Promise<string | undefined>(resolve => {
      const input = el('input', { type: 'password', placeholder: 'Your password', ariaLabel: 'Password' })
      const ok = el('button', { textContent: 'Continue' })
      const cancel = el('button', { textContent: 'Cancel' })
      const form = el('div', { class: 'actions' }, input, ok, cancel)
      const done = (value?: string) => { form.remove(); resolve(value) }
      ok.addEventListener('click', () => done(input.value))
      cancel.addEventListener('click', () => done())
      input.addEventListener('keydown', event => { if (event.key === 'Enter') done(input.value); else if (event.key === 'Escape') done() })
      message.before(form)
      input.focus()
    })
    const install = (scope: Scope) => act('Installing', () => scope === 'everyone' && !root
      ? withPassword(file => run(installCommand(info.name, scope, root, file)))
      : run(installCommand(info.name, scope, root)))
    if (!info.installed) {
      const me = el('button', { textContent: root ? 'Install' : 'Install for me', disabled: info.everyoneOnly && !root, title: info.everyoneOnly && !root ? 'This needs files under /usr: only an install for everyone can put them there' : '' })
      me.addEventListener('click', () => void install('me'))
      actions.append(me)
      if (!root) {
        const everyone = el('button', { textContent: 'Install for everyone' })
        everyone.addEventListener('click', () => void install('everyone'))
        actions.append(everyone)
      }
    } else {
      const remove = el('button', { textContent: 'Remove' })
      remove.addEventListener('click', () => void act('Removing', () => info.installed!.everyone && !root
        ? withPassword(file => run(removeCommand(info.name, true, root, file)))
        : run(removeCommand(info.name, info.installed!.everyone, root))))
      actions.append(remove)
      if (info.latest && info.latest !== info.installed.version) {
        const update = el('button', { textContent: 'Update' })
        update.addEventListener('click', () => void install(info.installed!.everyone ? 'everyone' : 'me'))
        actions.append(update)
      }
    }
    detail.replaceChildren(el('h2', { textContent: info.command ?? info.name }), el('div', { textContent: info.description }), facts, actions, message, ...(info.unreachable ? [el('div', { class: 'status', textContent: `The registry did not answer: ${info.unreachable}` })] : []))
  }

  const explore = (categories: Category[], filter: string) => {
    list.replaceChildren()
    for (const category of categories) {
      list.append(el('h3', { textContent: category.name }))
      for (const collection of category.collections) {
        const members = collection.members.filter(member => !filter || `${member.name} ${member.description}`.toLowerCase().includes(filter))
        if (!members.length && filter) continue
        list.append(item(collection.name, `${collection.installed} of ${collection.total} installed - ${collection.description}`, collection.package, 'collection'))
        for (const member of members) list.append(item(`  ${member.name}`, member.description, member.package, member.installed ? 'installed' : undefined))
      }
    }
    if (!list.childElementCount) status('Nothing matches.')
  }

  async function refresh() {
    try {
      if (tab === 'explore') {
        status('Loading...')
        const filter = search.value.trim().toLowerCase()
        explore(await software.explore(), filter)
      } else if (tab === 'installed') {
        status('Loading...')
        const rows = (await software.installed()).filter(row => !search.value || row.name.includes(search.value.trim().toLowerCase()))
        list.replaceChildren()
        const group = (title: string, items: InstalledRow[]) => { if (!items.length) return; list.append(el('h3', { textContent: `${title} (${items.length})` })); for (const row of items) list.append(item(row.name, `${row.version}${row.upgradable ? ` - ${row.upgradable} available` : ''} - ${row.description}`, row.name, row.upgradable ? 'update' : undefined)) }
        group('Asked for by name', rows.filter(row => row.explicit && !row.collection))
        group('Collections', rows.filter(row => row.collection && row.explicit))
        group('Dependencies', rows.filter(row => !row.explicit && !row.collection))
        if (!list.childElementCount) status('Nothing installed.')
      } else if (tab === 'updates') {
        status('Asking the registry...')
        const due = await software.updates()
        list.replaceChildren()
        for (const row of due) list.append(item(row.name, `${row.installed} -> ${row.latest}`, row.name))
        if (!due.length) status('Everything is up to date.')
      } else {
        notice.hidden = false
        if (!search.value.trim()) { status('Type what to look for and press Enter. These results come from npm and are not curated.'); return }
        status('Searching npm...')
        const { results, npm, unreachable } = await software.search(search.value.trim(), true)
        list.replaceChildren()
        if (unreachable) list.append(el('div', { class: 'error', textContent: `The registry did not answer: ${unreachable}` }))
        const rows = (heading: string, found: Row[]) => { if (!found.length) return; list.append(el('h3', { textContent: heading })); for (const row of found) list.append(item(row.name, `${row.version ?? ''} ${row.description}${row.publisher ? ` - ${row.publisher}${row.date ? `, ${row.date.slice(0, 10)}` : ''}` : ''}`, row.package, row.source === 'npm' ? 'unvetted' : undefined)) }
        rows('In the index', results)
        rows('More on npm (not curated)', npm)
        if (!list.childElementCount && !unreachable) status('Nothing found.')
      }
    } catch (error) {
      status(error instanceof Error ? error.message : String(error), true)
    }
  }

  const setTab = (next: Tab) => {
    tab = next
    notice.hidden = !(next === 'npm')
    search.placeholder = next === 'npm' ? 'Search npm (Enter)' : next === 'explore' ? 'Search the index' : 'Filter'
    for (const [name, button] of tabButtons) button.classList.toggle('on', name === next)
    void refresh()
  }
  for (const [name, label] of TABS) {
    const button = el('button', { textContent: label })
    button.addEventListener('click', () => setTab(name))
    tabButtons.set(name, button)
    bar.append(button)
  }
  bar.append(search)
  search.addEventListener('input', () => { if (tab !== 'npm') void refresh() })
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && tab === 'npm') void refresh() })

  const win = await kernel.windows.create({
    title: 'Software',
    width: Math.floor(window.innerWidth * 0.7),
    height: Math.floor(window.innerHeight * 0.75),
    onclose: () => { instance.exit(0); return false }
  })
  instance.keepAlive()
  instance.onDispose?.(() => win.close())
  win.mount(root_)
  setTab('explore')
  return 0
}

export default main

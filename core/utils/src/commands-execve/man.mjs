/**
 * Real `execve`'d `man` -- migrated off `Kernel.executeCommand`'s legacy shim
 * (`core/utils/src/commands/man.ts`). Documents are found and read with plain filesystem syscalls,
 * converted from Markdown/HTML to ANSI text exactly as before, and shown with the shared raw-mode
 * pager (`lib/pager.mjs`, also `less`'s). With no terminal (`man x | grep`, `man x > file`) it
 * prints the converted text instead of paging, as real man does.
 *
 * Dropped from the original: `parseMetadata`, whose result was never used, and the `kernel.i18n`
 * lookups, whose keys have no translations (the English defaults were the only output).
 */

import ansi from 'ansi-escape-sequences'

import { readTextFile } from './lib/fs-text.mjs'
import { join } from './lib/path-utils.mjs'
import { page } from './lib/pager.mjs'
import { pagerTty } from './lib/tty.mjs'

const { argv, env, exit, writeAll, stat, readdir, isDirectory } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: man [OPTION]... [@scope/]package[/topic[/subtopic...]]
Display manual pages.

  -l, --list    list available topics for a package
  --where PATH  override default documentation path
  --help        display this help and exit

Examples:
  man package-name               display index for package-name
  man @scope/package             display index for @scope/package
  man -l @scope/package          list topics for @scope/package
  man package-name/topic         display topic from package-name
  man @scope/package/docs        display docs/index from @scope/package`

const EXTENSIONS = ['.md', '.txt', '.html']

const exists = path => {
  try {
    stat(path)
    return true
  } catch {
    return false
  }
}

const extname = path => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

function resolveManPath(whereArg) {
  if (whereArg) return [whereArg]

  const manpath = env.MANPATH
  if (manpath) return manpath.split(':').filter(p => p.length > 0)

  return ['/usr/share/docs']
}

function parsePackagePath(pathStr) {
  if (!pathStr || pathStr.length === 0) return null

  const parts = pathStr.split('/')
  if (parts.length === 0) return null

  if (parts[0]?.startsWith('@')) {
    if (parts.length === 1) return null
    const firstPart = parts[0]
    const packageName = parts[1]
    if (!firstPart || !packageName) return null
    const scope = firstPart.slice(1)
    const topic = parts.length > 2 ? parts.slice(2).join('/') : undefined
    return { scope, package: packageName, topic }
  } else {
    const packageName = parts[0]
    if (!packageName) return null
    const topic = parts.length > 1 ? parts.slice(1).join('/') : undefined
    return { package: packageName, topic }
  }
}

function buildPackagePath(manpath, pkgPath) {
  if (pkgPath.scope) return join(manpath, `@${pkgPath.scope}`, pkgPath.package)
  return join(manpath, pkgPath.package)
}

function findDocument(packageDir, topic) {
  const baseName = topic || 'index'

  // First, check for a file with the topic name directly
  for (const ext of EXTENSIONS) {
    const filePath = join(packageDir, `${baseName}${ext}`)
    if (exists(filePath)) return filePath
  }

  // If topic contains a path or is a directory, look for index files in that directory
  if (topic) {
    const topicDir = join(packageDir, topic)
    try {
      if (isDirectory(topicDir)) {
        for (const ext of EXTENSIONS) {
          const indexPath = join(topicDir, `index${ext}`)
          if (exists(indexPath)) return indexPath
        }
      }
    } catch {
      // Directory doesn't exist, continue
    }
  }

  return null
}

function listTopics(packageDir, prefix = '') {
  const topics = []

  try {
    if (!exists(packageDir)) return topics

    for (const entry of readdir(packageDir)) {
      if (entry === 'metadata.json' || entry === 'index.md' || entry === 'index.txt' || entry === 'index.html') {
        continue
      }

      const fullPath = join(packageDir, entry)

      if (!isDirectory(fullPath)) {
        const ext = extname(entry)
        if (ext === '.md' || ext === '.txt' || ext === '.html') {
          const baseName = entry.slice(0, entry.length - ext.length)
          if (baseName && baseName !== 'index') {
            topics.push(prefix ? `${prefix}/${baseName}` : baseName)
          }
        }
      } else {
        // A subdirectory with an index file is itself a valid topic
        const hasIndex = EXTENSIONS.some(ext => exists(join(fullPath, `index${ext}`)))
        if (hasIndex) topics.push(prefix ? `${prefix}/${entry}` : entry)

        topics.push(...listTopics(fullPath, prefix ? `${prefix}/${entry}` : entry))
      }
    }
  } catch {
    // an unreadable directory just has no topics
  }

  return topics.sort()
}

function convertMarkdownToText(content) {
  let result = content

  // Strip HTML comments: <!-- ... -->
  // - Safe: Processed first to remove comments before any other processing
  // - Safe: Uses non-greedy match to handle multiple comments
  // - Safe: Can span multiple lines
  result = result.replace(/<!--[\s\S]*?-->/g, '')

  // Process code blocks FIRST to avoid processing markdown inside them
  // Code blocks: /^```[\s\S]*?^```/gm
  // - Pattern matches fenced code blocks (```...```)
  // - Uses non-greedy match to handle multiple code blocks
  // - Replace with placeholders that won't match any markdown patterns
  const codeBlockPlaceholders = []
  result = result.replace(/^```[\s\S]*?^```/gm, (match) => {
    const code = match.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '')
    const formatted = '\n' + code.split('\n').map(line => '  ' + line).join('\n') + '\n'
    const placeholder = `__CODE_BLOCK_${codeBlockPlaceholders.length}__`
    codeBlockPlaceholders.push(formatted)
    return placeholder
  })

  // Headings: /^(#{1,6})\s+(.+)$/gm
  // - Safe: Uses ^ and $ with m flag (line anchors)
  // - Safe: Requires whitespace after # characters
  // - Safe: Won't match inside code blocks (already replaced with placeholders)
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, text) => {
    const level = hashes.length
    if (level === 1) return ansi.format(text, ['bold', 'underline']) + '\n'
    else if (level === 2) return ansi.format(text, ['bold']) + '\n'
    else return ansi.format(text, ['bold']) + '\n'
  })

  // Inline code: /`([^`]+)`/g
  // - Safe: Processed after code blocks, so won't match inside code blocks
  // - Safe: [^`]+ ensures it won't match empty content
  // - Safe: Won't match across lines (backticks must be on same line)
  // - Safe: Processed early to protect code snippets from other markdown
  result = result.replace(/`([^`]+)`/g, (_, code) => ansi.format(code, ['cyan']))

  // Restore code blocks
  for (let i = 0; i < codeBlockPlaceholders.length; i++) {
    const placeholder = codeBlockPlaceholders[i]
    if (placeholder) {
      result = result.replace(`__CODE_BLOCK_${i}__`, placeholder)
    }
  }

  // Bold text: /\*\*(.+?)\*\*/g
  // - Safe: Processed after code blocks, so won't match inside code blocks
  // - Safe: Non-greedy (.+?) ensures it matches the shortest valid bold text
  // - Safe: Requires at least one character between ** (won't match empty)
  // - Safe: Processed BEFORE italic to avoid conflicts
  // - Note: Can match inside headings (e.g., "## **Bold Heading**") which is valid markdown
  result = result.replace(/\*\*(.+?)\*\*/g, (_, text) => ansi.format(text, ['bold']))

  // Italic text: /\*(?![*])(.+?)\*/g
  // - Safe: Processed after code blocks and bold, so won't match inside code blocks or **bold**
  // - Safe: Negative lookahead (?![*]) ensures it doesn't match if followed by *
  // - Safe: Non-greedy (.+?) ensures it matches the shortest valid italic text
  // - Safe: Requires at least one character between * (won't match empty)
  // - Safe: Can match inside bold text (e.g., "**bold *italic* bold**") which is valid markdown
  // - Note: Using 'gray' color since many terminals don't render italic styling visibly
  result = result.replace(/\*(?![*])(.+?)\*/g, (_, text) => ansi.format(text, ['gray']))


  // URLs: Color any URLs (http://, https://, mailto:) as blue
  // - Safe: Processed after code blocks, so won't match inside code blocks
  // - Safe: Matches common URL patterns, stops at whitespace or common punctuation
  // - Safe: Won't match URLs that are already inside formatted text (escape sequences)
  // - Note: Pattern excludes trailing punctuation like ), ], but allows . (periods are valid in URLs)
  const urlPattern = /(https?:\/\/[^\s<>"',;!)\]\)]+|mailto:[^\s<>"',;!)\]\)]+)/gi
  result = result.replace(urlPattern, (url) => {
    return ansi.format(url, ['blue'])
  })

  return result
}

function convertHtmlToText(content) {
  let result = content

  // Strip HTML comments: <!-- ... -->
  result = result.replace(/<!--[\s\S]*?-->/g, '')

  // Strip head, style, script, nav, footer tags and their content
  result = result.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  result = result.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  result = result.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
  result = result.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')

  // Add line breaks before/after block elements
  result = result.replace(/<br\s*\/?>/gi, '\n')
  result = result.replace(/<\/p>/gi, '\n\n')
  result = result.replace(/<\/div>/gi, '\n')
  result = result.replace(/<\/li>/gi, '\n')
  result = result.replace(/<\/tr>/gi, '\n')
  result = result.replace(/<hr[^>]*>/gi, '\n---\n')

  // List items - add bullet
  result = result.replace(/<li[^>]*>/gi, '  • ')

  result = result.replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['bold', 'underline']) + '\n'
  })

  result = result.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['bold']) + '\n'
  })

  result = result.replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['bold']) + '\n'
  })

  result = result.replace(/<strong[^>]*>(.*?)<\/strong>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['bold'])
  })

  result = result.replace(/<b[^>]*>(.*?)<\/b>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['bold'])
  })

  result = result.replace(/<em[^>]*>(.*?)<\/em>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['gray'])
  })

  result = result.replace(/<i[^>]*>(.*?)<\/i>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['gray'])
  })

  result = result.replace(/<code[^>]*>(.*?)<\/code>/gi, (_, text) => {
    return ansi.format(text.replace(/<[^>]+>/g, ''), ['cyan'])
  })

  result = result.replace(/<pre[^>]*>(.*?)<\/pre>/gis, (_, text) => {
    const code = text.replace(/<[^>]+>/g, '')
    return '\n' + code.split('\n').map((line) => '  ' + line).join('\n') + '\n'
  })

  result = result.replace(/<[^>]+>/g, '')

  // Decode HTML entities
  result = result.replace(/&nbsp;/g, ' ')
  result = result.replace(/&lt;/g, '<')
  result = result.replace(/&gt;/g, '>')
  result = result.replace(/&amp;/g, '&')
  result = result.replace(/&quot;/g, '"')
  result = result.replace(/&#39;/g, "'")
  result = result.replace(/&#x27;/g, "'")
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))

  // Clean up whitespace
  result = result.replace(/[ \t]+/g, ' ')
  result = result.replace(/\n[ \t]+/g, '\n')
  result = result.replace(/[ \t]+\n/g, '\n')
  result = result.replace(/\n{3,}/g, '\n\n')
  result = result.trim()

  // URLs: Color any URLs (http://, https://, mailto:) as blue
  const urlPattern = /(https?:\/\/[^\s<>"',;:!?)\]\)]+|mailto:[^\s<>"',;:!?)\]\)]+)/gi
  result = result.replace(urlPattern, (url) => {
    return ansi.format(url, ['blue'])
  })

  return result
}

const packageLabel = pkgPath => pkgPath.scope ? `@${pkgPath.scope}/${pkgPath.package}` : pkgPath.package

/** The document's text, converted for its format. */
function render(docFile) {
  const content = readTextFile(docFile)
  const ext = extname(docFile)
  if (ext === '.md') return convertMarkdownToText(content)
  if (ext === '.html') return convertHtmlToText(content)
  return content
}

/** Pages `text` on the terminal, or prints it when there is none to page on. */
function show(text, documentName) {
  const tty = pagerTty()
  if (tty === -1) out(text)
  else page(text.split('\n'), tty, documentName)
}

function printTopics(pkgPath, topics, hint) {
  const packageName = packageLabel(pkgPath)
  if (topics.length === 0) {
    out(`${packageName}: no topics available`)
    return
  }
  if (hint) {
    out(`No index found, try a topic: man ${packageName}/${topics[0]}`)
    out(`${packageName} topics:`)
  } else {
    out(`${packageName}:`)
  }
  for (const topic of topics) out(`  ${topic}`)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  let whereArg
  let topicPath
  let listTopicsFlag = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--where') {
      if (i + 1 < args.length) {
        i++
        whereArg = args[i]
      } else {
        err('man: missing argument to --where')
        return 1
      }
    } else if (arg === '--list' || arg === '-l') {
      listTopicsFlag = true
    } else if (arg.startsWith('--list') && arg.length > 6) {
      // `--list` concatenated with the package name
      listTopicsFlag = true
      topicPath = arg.slice(6)
    } else if (arg.startsWith('-l') && arg.length > 2) {
      // `-l` concatenated with the package name (e.g. "-l@zenfs/core")
      listTopicsFlag = true
      topicPath = arg.slice(2)
    } else if (!arg.startsWith('-')) {
      topicPath = arg
    }
  }

  if (!topicPath) topicPath = '@ecmaos/kernel'

  const pkgPath = parsePackagePath(topicPath)
  if (!pkgPath) {
    err(`man: invalid package path: ${topicPath}`)
    return 1
  }

  for (const manpath of resolveManPath(whereArg)) {
    const packageDir = buildPackagePath(manpath, pkgPath)
    if (!exists(packageDir)) continue

    if (listTopicsFlag) {
      printTopics(pkgPath, listTopics(packageDir), false)
      return 0
    }

    if (!pkgPath.topic) {
      const indexFile = findDocument(packageDir)
      if (indexFile) show(render(indexFile), packageLabel(pkgPath))
      else printTopics(pkgPath, listTopics(packageDir), true)
      return 0
    }

    const docFile = findDocument(packageDir, pkgPath.topic)
    if (!docFile) continue

    try {
      show(render(docFile), `${packageLabel(pkgPath)}/${pkgPath.topic}`)
      return 0
    } catch (error) {
      err(`man: error reading document: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return 1
    }
  }

  err(`man: no manual entry for ${topicPath}`)
  return 1
}

try {
  exit(main())
} catch (error) {
  err(`man: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}

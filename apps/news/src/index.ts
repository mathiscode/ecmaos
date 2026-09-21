#!ecmaos:bin:program:news

import type { ProcessEntryParams } from '@ecmaos/types'

const newsUrl = 'https://raw.githubusercontent.com/ecmaos/ecmaos/main/NEWS.md'

const main = async (params: ProcessEntryParams) => {
  const { args, terminal } = params
  const numEntries = parseInt(args[0] || '5')
  const news = await fetch(newsUrl || args[1])
  const newsData = await news.text()
  const entries = newsData.split('---').slice(1).slice(0, numEntries)
  for (const entry of entries) terminal.writeln(entry.trim())
}

export default main

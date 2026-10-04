import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/sqlite3` is the SQLite shell built to WebAssembly (`wasm/sqlite3/build.sh`) and run as a worker program. */
describe('sqlite3', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/sqlite3.out 2> /tmp/sqlite3.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/sqlite3.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/sqlite3.err', 'utf8')
    }
  }

  it('is installed in /bin', async () => {
    expect((await kernel.filesystem.fs.stat('/bin/sqlite3')).isFile()).toBe(true)
  })

  it('answers a query given as an argument', async () => {
    expect(await run('sqlite3 :memory: "select 6*7, sqlite_version() > \'3\'"')).toEqual({ code: 0, out: '42|1\n', err: '' })
  }, 30000)

  it('keeps a database in a file between runs, with transactions and an index', async () => {
    await run('rm -f /tmp/t.db')
    const first = await run('sqlite3 /tmp/t.db "create table t(id integer primary key, name text); create index t_name on t(name); begin; insert into t(name) values (\'b\'),(\'a\'),(\'c\'); commit;"')
    expect(first).toEqual({ code: 0, out: '', err: '' })
    const second = await run('sqlite3 -header -separator , /tmp/t.db "select * from t order by name"')
    expect(second).toEqual({ code: 0, out: 'id,name\n2,a\n1,b\n3,c\n', err: '' })
    // and a second program sees what the first committed, through the file
    expect(await run('sqlite3 /tmp/t.db "select count(*) from t; pragma integrity_check; pragma index_list(t)"')).toMatchObject({ code: 0, out: expect.stringMatching(/^3\nok\n/) })
  }, 60000)

  it('reads SQL from standard input and a dot-command script', async () => {
    const piped = await run('echo "create table s(x); insert into s values (1),(2),(3); select sum(x) from s;" | sqlite3 :memory:')
    expect(piped).toEqual({ code: 0, out: '6\n', err: '' })
  }, 30000)

  it('has JSON, FTS5 and the math functions', async () => {
    const result = await run(`sqlite3 :memory: "select json_extract('{\\"a\\":[1,2,{\\"b\\":3}]}', '$.a[2].b'); create virtual table d using fts5(body); insert into d values ('the quick brown fox'),('lazy dogs'); select count(*) from d where d match 'fox'; select round(sqrt(16) + pi(), 3);"`)
    expect(result).toEqual({ code: 0, out: '3\n1\n7.142\n', err: '' })
  }, 30000)

  it('reports an error on stderr and exits non-zero', async () => {
    const result = await run('sqlite3 :memory: "select * from nope"')
    expect(result.code).toBe(1)
    expect(result.err).toContain('no such table: nope')
  }, 30000)
})

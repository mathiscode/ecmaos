/**
 * Evaluates a `[[ ... ]]` compound test, tokenized by `shell-parser.ts`'s `tokenizeConditional`.
 * No word splitting or globbing happens inside `[[ ]]`; each word is expanded to one string
 * (`expandWordString`/`expandWordPattern`) and the unary/binary file-test and string/numeric
 * operators mirror `core/utils/src/commands/test.ts`'s `test`/`[` builtin, since `[[ ]]` is a
 * superset of it (plus `==`/`!=` globbing, `=~` regex, and `&&`/`||`/`!`/`(...)`).
 */

import type { ConditionalToken, WordPart } from '#lib/shell-parser.ts'
import { partsText } from '#lib/shell-parser.ts'
import { expandWordPattern, expandWordString, globToRegExpSource, type ExpansionContext } from '#lib/word-expansion.ts'

export interface ConditionalFs {
  exists(path: string): Promise<boolean>
  isFile(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  resolve(path: string): string
}

const UNARY_FILE_OPS = new Set(['-f', '-d', '-e'])
const UNARY_STRING_OPS = new Set(['-z', '-n'])

class ConditionalParser {
  private pos = 0
  constructor(private tokens: ConditionalToken[], private ctx: ExpansionContext, private fs: ConditionalFs, private setRematch: (groups: string[]) => void) {}

  private peek(): ConditionalToken | undefined { return this.tokens[this.pos] }
  private advance(): ConditionalToken | undefined { return this.tokens[this.pos++] }

  private isOp(value: string): boolean {
    const t = this.peek()
    return !!t && t.kind === 'op' && t.value === value
  }

  private wordText(token: ConditionalToken): string {
    if (token.kind !== 'word') throw new Error('[[: expected a word')
    return partsText((token as { parts: WordPart[] }).parts)
  }

  async parseOr(): Promise<boolean> {
    let result = await this.parseAnd()
    while (this.isOp('||')) { this.advance(); const rhs = await this.parseAnd(); result = result || rhs }
    return result
  }

  private async parseAnd(): Promise<boolean> {
    let result = await this.parseUnaryNot()
    while (this.isOp('&&')) { this.advance(); const rhs = await this.parseUnaryNot(); result = result && rhs }
    return result
  }

  private async parseUnaryNot(): Promise<boolean> {
    if (this.isOp('!')) { this.advance(); return !(await this.parseUnaryNot()) }
    return this.parsePrimary()
  }

  private async parsePrimary(): Promise<boolean> {
    if (this.isOp('(')) {
      this.advance()
      const result = await this.parseOr()
      if (!this.isOp(')')) throw new Error("[[: expected ')'")
      this.advance()
      return result
    }

    const token = this.advance()
    if (!token) throw new Error('[[: unexpected end of expression')

    if (token.kind === 'word') {
      const text = this.wordText(token)
      if (UNARY_FILE_OPS.has(text) || UNARY_STRING_OPS.has(text)) {
        const argToken = this.advance()
        if (!argToken) throw new Error(`[[: expected an argument after ${text}`)
        const arg = await expandWordString((argToken as { parts: WordPart[] }).parts, this.ctx)
        if (text === '-f') return this.fs.isFile(this.fs.resolve(arg))
        if (text === '-d') return this.fs.isDirectory(this.fs.resolve(arg))
        if (text === '-e') return this.fs.exists(this.fs.resolve(arg))
        if (text === '-z') return arg.length === 0
        return arg.length > 0 // -n
      }

      const left = await expandWordString((token as { parts: WordPart[] }).parts, this.ctx)
      const next = this.peek()

      if (next?.kind === 'word') {
        const opText = this.wordText(next)
        if (['==', '=', '!=', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(opText)) {
          this.advance()
          const rightToken = this.advance()
          if (!rightToken) throw new Error(`[[: expected an argument after ${opText}`)

          if (opText === '==' || opText === '=') {
            const pattern = await expandWordPattern((rightToken as { parts: WordPart[] }).parts, this.ctx, 'glob')
            return new RegExp(globToRegExpSource(pattern)).test(left)
          }
          if (opText === '!=') {
            const pattern = await expandWordPattern((rightToken as { parts: WordPart[] }).parts, this.ctx, 'glob')
            return !new RegExp(globToRegExpSource(pattern)).test(left)
          }
          if (opText === '=~') {
            const pattern = await expandWordString((rightToken as { parts: WordPart[] }).parts, this.ctx)
            const match = new RegExp(pattern).exec(left)
            this.setRematch(match ? [...match] : [])
            return match !== null
          }

          const right = await expandWordString((rightToken as { parts: WordPart[] }).parts, this.ctx)
          const l = Number(left)
          const r = Number(right)
          switch (opText) {
            case '-eq': return l === r
            case '-ne': return l !== r
            case '-lt': return l < r
            case '-le': return l <= r
            case '-gt': return l > r
            case '-ge': return l >= r
          }
        }
      }

      if (next?.kind === 'op' && (next.value === '<' || next.value === '>')) {
        this.advance()
        const rightToken = this.advance()
        if (!rightToken) throw new Error(`[[: expected an argument after ${next.value}`)
        const right = await expandWordString((rightToken as { parts: WordPart[] }).parts, this.ctx)
        return next.value === '<' ? left < right : left > right
      }

      return left.length > 0
    }

    throw new Error('[[: unexpected token in expression')
  }
}

/**
 * Evaluates a tokenized `[[ ... ]]` expression, returning its boolean result. `setRematch` is
 * called with the `=~` match's capture groups (index 0 = whole match) whenever `=~` runs, so the
 * caller can populate `BASH_REMATCH`.
 */
export async function evaluateConditional(
  tokens: ConditionalToken[],
  ctx: ExpansionContext,
  fs: ConditionalFs,
  setRematch: (groups: string[]) => void
): Promise<boolean> {
  if (tokens.length === 0) return false
  const parser = new ConditionalParser(tokens, ctx, fs, setRematch)
  return parser.parseOr()
}

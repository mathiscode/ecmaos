import { defineConfig } from 'cf/config'

// A Worker with no code: Workers static assets serve core/kernel/dist (see wrangler.config.ts) and apply its _headers file
export default defineConfig({
  worker: {
    name: 'ecmaos',
    compatibilityDate: '2026-10-06'
  }
})

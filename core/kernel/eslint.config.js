import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/scripts/templates/**']
  },
  {
    languageOptions: { globals: globals.browser }
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-control-regex': 'off',
      'no-empty': 'off',
      // `_`-prefixed names are deliberately unused (syscall signatures that must keep every
      // positional arg), and so are bare `catch (e)` bindings - match `noUnusedParameters`.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }]
    }
  },
  {
    // the Node built-ins are CommonJS files the loader runs: `require`, `module` and `exports` are theirs
    files: ['src/bin/node-builtins/builtins/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.browser, ...globals.commonjs, process: 'readonly', Buffer: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-redeclare': ['error', { builtinGlobals: false }] }
  }
]
# Contributing to ecmaOS

Thank you for your interest in contributing to ecmaOS! We welcome contributions from the community and appreciate your help in making this project better.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [code@mathis.network](mailto:code@mathis.network).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the issue list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

* Use a clear and descriptive title
* Describe the exact steps which reproduce the problem
* Provide specific examples to demonstrate the steps
* Describe the behavior you observed after following the steps
* Explain which behavior you expected to see instead and why
* Include screenshots if possible

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

* A clear and descriptive title
* A detailed description of the proposed functionality
* Any possible drawbacks
* Why this enhancement would be useful

### Pull Requests

* Fork the repo and create your branch from `main`
* If you've added code that should be tested, add tests
* Ensure the test suite passes
* Make sure your code follows the existing code style
* Write a convincing description of your PR and why we should land it

## Development Setup

1. Fork and clone the repo
2. Run `pnpm install` to install dependencies
3. Create a branch for your changes
4. Make your changes
5. Run tests with `pnpm test`
6. Push to your fork and submit a pull request

### Running the kernel tests

Run these from `core/kernel` (or add `--filter @ecmaos/kernel` from the root).

| Command | What it runs | About |
|---|---|---|
| `pnpm test` | Every test except the corpus suites and the Vim tests | 4.5 minutes |
| `pnpm test:changed [base]` | The tests that import what you changed, plus the corpus cases for any command in `commands-execve/` you changed | depends |
| `pnpm test:group <name>` | One family: `shell`, `posix`, `gnu-tools`, `gnu-coreutils`, `parity`, `commands`, `wasi`, `accounts`, `boot`, `slow` | 1 to 3 minutes |
| `pnpm test:corpus` | Only the corpus suites (`*.corpus.test.ts`: commands compared with what the real tools print) | 2 minutes |
| `pnpm test:full` | Everything | 6 minutes |

CI runs `pnpm test` on every push and the full set once a month and on request (the "Full tests" workflow).

## Style Guide

* Use TypeScript
* Follow the existing code style
* Write clear commit messages
* Add tests for new functionality
* Update documentation for changes

## Typecheck error-budget ratchet

The budget is **0** - `tsc --noEmit` must report zero diagnostics. The dual
`@zenfs/core` copies and stray `vim-wasm` sources that used to produce a
pre-existing error baseline are gone; there is no longer a tolerated error count to work within.

CI enforces this with `scripts/typecheck-ratchet.mjs`, which runs
`tsc --noEmit` in `core/kernel` **after `pnpm build`**, counts diagnostics, and
compares against the budget in `.ci/typecheck-baseline.json`. Run it after a
build locally too - several packages resolve their types from `dist/`, so the
count is only stable once `dist/` is populated.

* **Any error at all** - CI fails. Fix it; there is no headroom to spend.
* If a legitimate reason ever reopens headroom (a new third-party dependency
  with broken types, say), raise the budget deliberately with
  `node scripts/typecheck-ratchet.mjs --write` and explain why in the commit -
  don't let it drift up silently.

The number only ever ratchets down from wherever it's set.

## License

By contributing to ecmaOS, you agree that your contributions will be licensed under its MIT license.

## Questions?

Feel free to open an issue with your question or contact the maintainers directly.

Thank you for contributing!

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

## Style Guide

* Use TypeScript
* Follow the existing code style
* Write clear commit messages
* Add tests for new functionality
* Update documentation for changes

## Typecheck error-budget ratchet

The `feat/1.0.0` overhaul carries a body of pre-existing `tsc` errors (dual
`@zenfs/core` copies across the workspace, plus third-party `vim-wasm` sources
pulled into the program). Fixing them all up front is not a prerequisite for the
overhaul, but the count must not grow while it is in progress.

CI enforces this with `scripts/typecheck-ratchet.mjs`, which runs
`tsc --noEmit` in `core/kernel` **after `pnpm build`**, counts diagnostics, and
compares against the budget in `.ci/typecheck-baseline.json`. Run it after a
build locally too — several packages resolve their types from `dist/`, so the
count is only stable once `dist/` is populated.

* **More errors than the budget** — CI fails. Fix the new errors.
* **Fewer errors than the budget** — CI passes with a warning. Run
  `node scripts/typecheck-ratchet.mjs --write` and commit the updated
  `.ci/typecheck-baseline.json` so the improvement is locked in.

The number only ever ratchets down.

## License

By contributing to ecmaOS, you agree that your contributions will be licensed under its MIT license.

## Questions?

Feel free to open an issue with your question or contact the maintainers directly.

Thank you for contributing!

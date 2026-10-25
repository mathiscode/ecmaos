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

## The initfs

`core/kernel/public/initfs/` is what a new machine's filesystem starts with, and `core/kernel/public/initfs.tar.gz` is
what the kernel actually fetches. A machine unpacks `/usr/share` again whenever the tarball changes, so the two have to
move together:

* Change the folder, then run `pnpm sync:initfs` (the kernel's `dev` and `build` do it too, when GNU tar is installed)
  and commit the tarball with the change. The tarball is reproducible: the same folder always gives the same bytes.
* Some files in the folder are copies of files kept elsewhere (the README, the API docs, the license texts of the
  kernel and both coreutils packages). Change the source, then run its sync (`pnpm sync:readme`, `sync:docs`,
  `sync:licenses`) before `sync:initfs`.
* `pnpm check:initfs` says whether the tarball matches the folder and every copy matches its source, and which sync
  fixes what does not. CI runs it.

## License

ecmaOS is MIT OR Apache-2.0. By contributing, you agree that your contribution is licensed under the license of the part of the repository it goes into:

* Almost everywhere, that is **MIT OR Apache-2.0**, the same as the rest of the project.
* In `core/utils-copyleft`, a change to a program's build or to a file linked into it is licensed as that program is (GPL-2.0-or-later, GPL-3.0-or-later or the Vim license; `licenses/<program>/SOURCE` and the manifest say which). Keep new GPL code in that package and the program a separate process: the kernel and the permissive packages never import or link it (`pnpm check:license-boundary` fails if they do).
* A new program or library under another license needs its notice in `licenses/` and an entry in the package's `programs/manifest.json`, and a new dependency must be under a license on `scripts/license-allowlist.json` (`pnpm check:licenses`); anything copyleft is a decision for a maintainer.

### Sign your commits

Every commit needs a `Signed-off-by: Your Name <you@example.com>` line, which says you wrote the change or have the right to contribute it under that license (the [Developer Certificate of Origin](https://developercertificate.org/)). Add it with `git commit -s`, or to commits already made with `git rebase --signoff main`. CI checks the commits of a pull request (`node scripts/check-dco.mjs origin/main..HEAD` does the same locally); merge commits, bots and the maintainer (the project's copyright holder) are skipped.

### What CI checks about licenses

* `reuse lint` (REUSE 3.3): every file has a license and a copyright holder. A file's own `SPDX-License-Identifier` header wins; otherwise `REUSE.toml` says. `REUSE.toml` is generated from the programs' manifests by `pnpm sync:reuse`; do not edit it by hand. The license texts are in `LICENSES/`.
* `pnpm check:licenses`: every dependency is under an allowed license.
* `pnpm check:license-boundary`: nothing but `@ecmaos/coreutils-copyleft` holds, depends on or imports the copyleft programs; after a build, `node scripts/check-license-boundary.mjs --dist` checks the bundles too.
* `pnpm check:initfs`: the notices in the initfs (and the copies shipped with `@ecmaos/node` and `@ecmaos/jaffa`) match their sources; `pnpm sync:licenses` refreshes them.

## Questions?

Feel free to open an issue with your question or contact the maintainers directly.

Thank you for contributing!

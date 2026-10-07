#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Packs the subset of Vim's runtime that ecmaOS ships into programs/vim-runtime.tar.gz, rooted at /, so it unpacks to
# /usr/share/vim/vim91 (the directory build.sh compiles in). The kernel installs it beside `vim` (see the `runtime` entry
# of programs/manifest.json). Run it to change the subset, then `node ../../utils/programs-manifest.mjs`; the result is committed.
# The runtime is under the Vim license, so it ships with this package and not with the permissively licensed initfs.
#
# The subset is what makes `syntax on` and `filetype on` work for the languages people edit here.
# Left out on purpose: doc/ (`:help` needs ~3 MB for its tags and text), the other ~600 syntax
# files, tutor, spell, lang and the plugins that need Vim9 script support from interpreters.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version vim)
ARCHIVE=$(node "$SOURCES" fetch vim)
WORK=$(mktemp -d)
DEST=$WORK/image/usr/share/vim/vim91
trap 'rm -rf "$WORK"' EXIT

tar xzf "$ARCHIVE" -C "$WORK"
SRC=$WORK/vim-$VERSION/runtime

LANGS="c cpp sh bash zsh javascript typescript json jsonc python vim html css scss markdown make
  yaml toml dockerfile conf cfg ini xml sql lua rust go java diff gitcommit gitconfig gitrebase
  git text help ecmascript javascriptreact typescriptreact cmake config sshconfig crontab passwd
  group fstab resolv readline vimrc tex asm perl ruby php"

rm -rf "$DEST"
mkdir -p "$DEST/syntax" "$DEST/ftplugin" "$DEST/indent" "$DEST/colors" "$DEST/autoload"
for f in filetype.vim ftplugin.vim ftoff.vim indent.vim ftplugof.vim indoff.vim scripts.vim; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/"
done
for f in syntax.vim synload.vim syncolor.vim nosyntax.vim shared.vim manual.vim; do
  [ -f "$SRC/syntax/$f" ] && cp "$SRC/syntax/$f" "$DEST/syntax/"
done
for l in $LANGS; do
  [ -f "$SRC/syntax/$l.vim" ] && cp "$SRC/syntax/$l.vim" "$DEST/syntax/"
  [ -f "$SRC/ftplugin/$l.vim" ] && cp "$SRC/ftplugin/$l.vim" "$DEST/ftplugin/"
  [ -f "$SRC/indent/$l.vim" ] && cp "$SRC/indent/$l.vim" "$DEST/indent/"
  # helpers the ftplugin and indent scripts call (python#GetIndent, rust#Jump, htmlcomplete#..., ...)
  for a in "$l" "${l}complete"; do
    [ -f "$SRC/autoload/$a.vim" ] && cp "$SRC/autoload/$a.vim" "$DEST/autoload/"
  done
done
# Syntax files that other syntax files pull in with `runtime! syntax/x.vim`.
for l in c cpp html css javascript xml sh vim; do
  [ -f "$SRC/ftplugin/$l.vim" ] && cp "$SRC/ftplugin/$l.vim" "$DEST/ftplugin/"
done
cp "$SRC/colors/"{default,desert,industry,slate,peachpuff,ron,murphy,evening}.vim "$DEST/colors/" 2>/dev/null || true
mkdir -p "$DEST/colors/lists" && cp "$SRC/colors/lists/"*.vim "$DEST/colors/lists/"
# filetype detection by file name and content calls into autoload/dist
mkdir -p "$DEST/autoload/dist" && cp "$SRC/autoload/dist/"*.vim "$DEST/autoload/dist/"
cp "$SRC/autoload/syntaxcomplete.vim" "$SRC/autoload/ccomplete.vim" "$DEST/autoload/" 2>/dev/null || true
# What the copied files themselves pull in (`runtime syntax/x.vim`, `syntax include`, `compiler x`, autoload
# calls such as `python#GetIndent()`), repeated until nothing new turns up.
mkdir -p "$DEST/compiler" "$DEST/syntax/shared"
cp "$SRC/syntax/shared/"*.vim "$DEST/syntax/shared/"
python3 - "$SRC" "$DEST" <<'PY'
import os, re, shutil, sys
src, dest = sys.argv[1:3]
ref = re.compile(r'\b((?:syntax|ftplugin|indent|autoload|compiler)/[A-Za-z0-9_/.-]+\.vim)')
compiler = re.compile(r'^\s*compiler!?\s+([A-Za-z0-9_]+)', re.M)
sibling = re.compile(r'<sfile>:p:h/([A-Za-z0-9_.-]+\.vim)')
autoload = re.compile(r'\b([A-Za-z_]+(?:#[A-Za-z_]+)+)\(')
queue = [os.path.join(d, f) for d, _, fs in os.walk(dest) for f in fs if f.endswith('.vim')]
seen = set(queue)
def want(rel):
    s, d = os.path.join(src, rel), os.path.join(dest, rel)
    if os.path.isfile(s) and not os.path.exists(d):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy(s, d)
        queue.append(d)
while queue:
    path = queue.pop()
    text = open(path, errors='replace').read()
    for m in ref.findall(text): want(m)
    for m in compiler.findall(text): want(f'compiler/{m}.vim')
    for m in sibling.findall(text): want(os.path.join(os.path.dirname(os.path.relpath(path, dest)), m))
    for m in autoload.findall(text): want('autoload/' + '/'.join(m.split('#')[:-1]) + '.vim')
PY
cp "$SRC/defaults.vim" "$DEST/" 2>/dev/null || true
du -sh "$DEST"

# The same bytes for the same input, so a rerun that changes nothing leaves the committed tarball (and its hash) alone
OUT="$HERE/../../programs/vim-runtime.tar.gz"
tar --sort=name --owner=root --group=root --numeric-owner --mtime=@0 -C "$WORK/image" -cf - . | gzip -n -9 > "$OUT"
echo "wrote $OUT"

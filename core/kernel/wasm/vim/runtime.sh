#!/usr/bin/env bash
# Copies the subset of Vim's runtime that ecmaOS ships into initfs, at /usr/share/vim/vim91
# (the directory build.sh compiles in). Run it to change the subset; the result is committed.
#
# The subset is what makes `syntax on` and `filetype on` work for the languages people edit here.
# Left out on purpose: doc/ (`:help` needs ~3 MB for its tags and text), the other ~600 syntax
# files, tutor, spell, lang and the plugins that need Vim9 script support from interpreters.
set -euo pipefail

VERSION=9.1.0
SHA256=ddb435f6e386c53799a3025bdc5a3533beac735a0ee596cb27ada97366a1c725
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=$HERE/../../public/initfs/usr/share/vim/vim91
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -fsSL -o "$WORK/vim.tar.gz" "https://github.com/vim/vim/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  $WORK/vim.tar.gz" | sha256sum -c -
tar xzf "$WORK/vim.tar.gz" -C "$WORK"
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

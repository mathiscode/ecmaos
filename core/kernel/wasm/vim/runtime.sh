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
mkdir -p "$DEST/syntax" "$DEST/ftplugin" "$DEST/indent" "$DEST/colors"
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
done
# Syntax files that other syntax files pull in with `runtime! syntax/x.vim`.
for l in c cpp html css javascript xml sh vim; do
  [ -f "$SRC/ftplugin/$l.vim" ] && cp "$SRC/ftplugin/$l.vim" "$DEST/ftplugin/"
done
cp "$SRC/colors/"{default,desert,industry,slate,peachpuff,ron,murphy,evening}.vim "$DEST/colors/" 2>/dev/null || true
mkdir -p "$DEST/colors/lists" && cp "$SRC/colors/lists/"*.vim "$DEST/colors/lists/"
mkdir -p "$DEST/autoload" "$DEST/lang"
cp "$SRC/autoload/dist/ft.vim" "$DEST/autoload/ft.vim" 2>/dev/null || true
mkdir -p "$DEST/autoload/dist" && cp "$SRC/autoload/dist/ft.vim" "$DEST/autoload/dist/" 2>/dev/null || true
rmdir "$DEST/autoload/dist" "$DEST/autoload" "$DEST/lang" 2>/dev/null || true
cp "$SRC/defaults.vim" "$DEST/" 2>/dev/null || true
du -sh "$DEST"

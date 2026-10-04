/**
 * The system vimrc, `/etc/vimrc` (the Vim build points `SYS_VIMRC_FILE` here -- see `wasm/vim/build.sh`).
 * Vim with no vimrc at all starts in vi-compatible mode, so this is what makes `vim` behave like Vim.
 * `TERM` is `xterm.js`, a name Vim has no entry for, so it falls back to a generic terminal with no
 * alternate screen; xterm.js speaks xterm, so say so. Swap and backup files are off: the filesystem is
 * the user's browser storage, and a crash leaves `.swp` files nobody would think to look for.
 */
export const DEFAULT_VIMRC = `" System vimrc for ecmaOS. Put your own in ~/.vimrc.
" Vim sources this a second time as its "defaults.vim" when there is no ~/.vimrc (the build points both here).
if exists('g:ecmaos_vimrc') | finish | endif
let g:ecmaos_vimrc = 1
set nocompatible
if &term ==# 'xterm.js'
  set term=xterm
  " the builtin entry has no alternate screen; xterm.js has one, and without it Vim's screen stays behind on exit
  let &t_ti = "\\<Esc>[?1049h"
  let &t_te = "\\<Esc>[?1049l"
endif
set nobackup
set nowritebackup
set noswapfile
set viminfo=
set backspace=indent,eol,start
set ruler
set showcmd
set incsearch
set hlsearch
set nomodeline
" xterm.js draws 256 colors and truecolor; the builtin xterm entry only knows eight
set t_Co=256
set background=dark
if isdirectory($VIMRUNTIME . '/syntax')
  filetype plugin indent on
  syntax on
endif
`

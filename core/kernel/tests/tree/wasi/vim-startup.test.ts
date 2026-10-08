import { defineVim } from '../fixtures/vim.suite'

defineVim(["detects the filetype and", "says in :version", "detects the common filetypes", "writes a system vimrc", "takes ^C as a key", "starts without"])

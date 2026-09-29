---
"@ecmaos/kernel": patch
---

A closing keyword followed by more on the same line now closes its block.

`while false; do echo x; done; echo after` left `done; echo after` as a single parser line whose
first word was `done;`, so the loop was never recognized as closed and the whole thing reported as
incomplete input -- at an interactive prompt, a continuation `> ` with no way out.

`fi`, `done` and `esac` were grouped with `if`/`while`/`for` as "start a new line, then keep
accumulating", which is right for an opener and wrong for a closer. They now own their line up to
the next top-level `;`, and what follows that `;` starts a line of its own. Only up to the `;`,
because a closing keyword can legitimately carry a redirection (`done < input.txt`) that belongs
with it.

Found in a browser: the shape is unremarkable in a multi-line script, and one-line function bodies
made it routine -- `p() { while getopts "vf:" o; do ...; done; shift $((OPTIND-1)); }` is the usual
way to write an option parser, and it hung the prompt.

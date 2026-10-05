# expr

`man @ecmaos/coreutils/expr`

## Synopsis

```
expr EXPRESSION
```

## Description

Prints the value of EXPRESSION. Every operator and operand is its own argument, so the characters the shell uses need quoting: `expr 2 \* 3`, `expr \( 1 + 2 \) \* 3`. Lowest precedence first: `A | B` (A unless it is empty or 0, else B), `A & B`, comparisons `< <= = == != >= >` (numeric when both sides are integers, else strings), `+ -`, `* / %`, and `STRING : REGEX`, an anchored match that gives the length of the match, or the part inside `\( \)`. Also `length STRING`, `substr STRING POS LENGTH`, `index STRING CHARS`, `match STRING REGEX` and `+ TOKEN` (the token as a string even if it is an operator).

## Exit status

0 when the result is neither empty nor 0, 1 when it is, 2 for a syntax error, 3 for an error while evaluating (a division by zero).

## See also

`@ecmaos/coreutils/ecmash`

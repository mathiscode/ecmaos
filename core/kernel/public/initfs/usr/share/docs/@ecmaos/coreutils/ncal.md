# ncal

`man @ecmaos/coreutils/ncal`

## Synopsis

```
ncal [-3jwyM] [[month] year]
```

## Description

The calendar with the days running down the page, a week to a column: `cal -v`, with ncal's spelling. `-M` starts the week on Monday, `-3` shows three months, `-y` a year, `-j` day-of-year numbers and `-w` week numbers. The calendar is Julian before September 1752, as `cal` is.

## Examples

```
ncal
ncal -M 2 2026
ncal -3
```

## See also

`@ecmaos/coreutils/cal`

## License

MIT OR Apache-2.0.

# units

`man @ecmaos/coreutils/units`

## Synopsis

```
units [-1t] [from-unit to-unit]
```

## Description

Converts a quantity between units. A unit expression is a number, units multiplied by a space or `*`, divided by `/` or `per`, powered with `^` (`m^2`, or `m2`), a fraction like `1|2`, or in parentheses. The SI and binary prefixes work on any unit (`kibibyte`, `MiB`, `milliamp`), and a plural is read as the singular. `tempC(20)`, `tempF`, `tempK` and `tempR` convert temperatures. The result is `* factor` and `/ inverse`, with `-1` only the first and `-t` only the number. Units of different kinds give a conformability error. With no operands it prompts "You have:" and "You want:" for each pair of lines on standard input.

The units are a built-in table of the common SI, imperial, US customary, energy, pressure, data and time units, not the full GNU database.

## Examples

```
units ft m
units -t "tempF(212)" tempC
units "2 hours" min
```

## See also

`@ecmaos/coreutils/numfmt`, `@ecmaos/coreutils/dc`, `@ecmaos/coreutils/expr`

## License

MIT OR Apache-2.0.

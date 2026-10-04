# jq

`man @ecmaos/kernel/commands/jq`

## Synopsis

```
jq [OPTIONS] FILTER [FILE]...
```

## Description

jq 1.8, the JSON processor, built to WebAssembly and run as an ordinary program. It reads JSON from the
files or standard input, applies `FILTER`, and writes the results. The whole language is there: paths,
`select`, `map`, `reduce`, `limit`, `group_by`, `@csv`/`@tsv`/`@base64`/`@uri` formatters, `test`/`match`/
`sub` regular expressions (Oniguruma), dates (`fromdateiso8601`, `strptime`, `strftime`, `todate`) and
arithmetic on arbitrary-precision numbers.

## Options

`-r` raw string output, `-c` compact, `-s` slurp all inputs into an array, `-n` no input, `-e` exit 1 when the
last output is false or null, `-S` sort keys, `--arg NAME VALUE`, `--argjson NAME JSON`, `--slurpfile NAME
FILE`, `--tab`, `--indent N`, `-f FILE` read the filter from a file, `--seq`, and the rest of `jq --help`.

Exit status: 0 on success; 2 for a usage error, 3 for a filter that does not compile, 5 for a runtime error or input
that is not JSON. With `-e`: 1 when the last output was false or null, 4 when there was no output.

## Examples

```
echo '{"a":[1,2,3]}' | jq '.a | add'
jq -r '.[] | select(.age > 40) | .name' people.json
jq -c 'group_by(.team) | map({team: .[0].team, n: length})' data.json
jq -n '"2024-03-05T10:20:30Z" | fromdateiso8601'
```

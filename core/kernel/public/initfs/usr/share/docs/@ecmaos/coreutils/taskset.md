# taskset

`man @ecmaos/coreutils/taskset`

## Synopsis

```
taskset [-c] MASK|LIST COMMAND [ARG]...
taskset -p [-c] [MASK|LIST] PID
```

## Description

Run a command on chosen CPUs, or show the CPUs a process may use. Every process here is a worker the browser places as it likes, so a mask or list is checked and not applied; `-p` shows the full set of CPUs the machine has.

## Options

```
  -c, --cpu-list   MASK is a list such as 0,2-3
  -p, --pid        operate on an existing PID
```

## Example

```
taskset -c 0 make -j4
```

# wait

`man @ecmaos/coreutils/wait`

## Synopsis

```
wait [%JOBSPEC | PID]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Waits for a background job, or for every one when none is named, and returns its exit status.

## Examples

```
sleep 5 &
wait
echo $?
```

## Exit status

The status of the job waited for; 0 when waiting for all.

## See also

`jobs`, `fg`

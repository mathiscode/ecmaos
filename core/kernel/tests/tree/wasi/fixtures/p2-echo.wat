;; A WASI program made into a Preview 2 component by p2-echo.build.mjs: it writes each argument after the first on a
;; line of its own, copies stdin to stdout, says "p2-echo: done" on stderr and exits with the number of arguments it
;; was given (0 for none)
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 2)

  ;; 0: argc, 4: argv buffer size, 16: one iovec, 32: bytes moved, 64: "\n", 80: the stderr line
  ;; 1024: argv pointers, 8192: argv strings, 65536: the stdin buffer (64 KiB)
  (data (i32.const 64) "\n")
  (data (i32.const 80) "p2-echo: done\n")

  (func $write (param $fd i32) (param $ptr i32) (param $len i32)
    (i32.store (i32.const 16) (local.get $ptr))
    (i32.store (i32.const 20) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 16) (i32.const 1) (i32.const 32))))

  (func $strlen (param $ptr i32) (result i32)
    (local $end i32)
    (local.set $end (local.get $ptr))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (i32.load8_u (local.get $end))))
        (local.set $end (i32.add (local.get $end) (i32.const 1)))
        (br $next)))
    (i32.sub (local.get $end) (local.get $ptr)))

  (func (export "_start")
    (local $argc i32)
    (local $i i32)
    (local $arg i32)
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (local.set $argc (i32.load (i32.const 0)))
    (drop (call $args_get (i32.const 1024) (i32.const 8192)))
    (local.set $i (i32.const 1))
    (block $args_done
      (loop $next_arg
        (br_if $args_done (i32.ge_u (local.get $i) (local.get $argc)))
        (local.set $arg (i32.load (i32.add (i32.const 1024) (i32.mul (local.get $i) (i32.const 4)))))
        (call $write (i32.const 1) (local.get $arg) (call $strlen (local.get $arg)))
        (call $write (i32.const 1) (i32.const 64) (i32.const 1))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next_arg)))
    (block $stdin_done
      (loop $next_read
        (i32.store (i32.const 16) (i32.const 65536))
        (i32.store (i32.const 20) (i32.const 65536))
        (br_if $stdin_done (call $fd_read (i32.const 0) (i32.const 16) (i32.const 1) (i32.const 32)))
        (br_if $stdin_done (i32.eqz (i32.load (i32.const 32))))
        (call $write (i32.const 1) (i32.const 65536) (i32.load (i32.const 32)))
        (br $next_read)))
    (call $write (i32.const 2) (i32.const 80) (i32.const 14))
    (if (i32.gt_u (local.get $argc) (i32.const 1))
      (then (call $proc_exit (i32.sub (local.get $argc) (i32.const 1)))))))

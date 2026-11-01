// A std program built with the Go toolchain for GOOS=wasip1 GOARCH=wasm: the same checks as rust-wasip1.rs.
package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func main() {
	args := os.Args[1:]
	fmt.Printf("args=%s\n", strings.Join(args, ","))
	fmt.Printf("home=%s\n", os.Getenv("HOME"))
	fmt.Fprintln(os.Stderr, "go-wasip1: stderr")

	path := "/tmp/go-wasip1.txt"
	if err := os.WriteFile(path, []byte("made by go\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(100)
	}
	text, _ := os.ReadFile(path)
	fmt.Printf("file=%s\n", strings.TrimSpace(string(text)))

	os.MkdirAll("/tmp/go-wasip1-dir/sub", 0o755)
	os.WriteFile("/tmp/go-wasip1-dir/b.txt", []byte("b"), 0o644)
	os.WriteFile("/tmp/go-wasip1-dir/a.txt", []byte("a"), 0o644)
	entries, _ := os.ReadDir("/tmp/go-wasip1-dir")
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	fmt.Printf("dir=%s\n", strings.Join(names, ","))
	fmt.Printf("clock=%v\n", time.Now().Unix() > 1700000000)

	if len(args) > 0 && args[0] == "stdin" {
		input, _ := io.ReadAll(os.Stdin)
		fmt.Printf("stdin=%s", input)
	}

	code := 0
	if len(args) > 1 {
		code, _ = strconv.Atoi(args[1])
	}
	os.Exit(code)
}

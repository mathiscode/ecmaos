#!/bin/sh

set -e

DOCS_PATH="documentation"

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Syncs one upstream repo's docs into $2 (a path under core/kernel/public/initfs/usr/share/docs).
# Copies the documentation/ folder when the repo still ships one; always copies README.md as
# index.md, since that's the one thing every one of these repos reliably has.
sync_repo() {
    REPO_URL="$1"
    TARGET_DIR="$2"
    TEMP_DIR=$(mktemp -d)

    echo "Syncing $REPO_URL -> $TARGET_DIR"

    cleanup() {
        if [ -d "$TEMP_DIR" ]; then
            rm -rf "$TEMP_DIR"
        fi
    }
    trap cleanup EXIT

    mkdir -p "$PROJECT_ROOT/$TARGET_DIR"

    echo "Cloning $REPO_URL..."
    git clone --depth 1 --filter=blob:none "$REPO_URL" "$TEMP_DIR" -q

    cd "$TEMP_DIR"
    git sparse-checkout init --cone
    git sparse-checkout set "$DOCS_PATH"

    # Protect against unset or empty variables before removing files
    if [ -z "$PROJECT_ROOT" ] || [ -z "$TARGET_DIR" ]; then
        echo "Error: PROJECT_ROOT and TARGET_DIR must be set and non-empty before removing files."
        exit 1
    fi

    # Double-check to prevent accidental deletion of important directories
    if [ "$PROJECT_ROOT/$TARGET_DIR" = "/" ] || [ "$PROJECT_ROOT/$TARGET_DIR" = "" ]; then
        echo "Error: Will not remove top-level or empty path. Aborting."
        exit 1
    fi

    if [ ! -d "$PROJECT_ROOT/$TARGET_DIR" ]; then
        echo "Error: Target directory $PROJECT_ROOT/$TARGET_DIR does not exist (should have been created); aborting."
        exit 1
    fi

    # Remove existing files in target directory
    rm -rf "${PROJECT_ROOT:?}/${TARGET_DIR:?}"/*

    # Copy the documentation/ folder when the repo still has one. Some upstream repos have moved
    # their docs out of the repo entirely (e.g. onto a hosted site); when that's the case, README.md
    # (copied below) is the only reference material available, and that's fine.
    if [ -d "$DOCS_PATH" ] && [ -n "$(ls -A "$DOCS_PATH" 2>/dev/null)" ]; then
        echo "Copying documentation/ folder..."
        cp -r "$DOCS_PATH"/* "$PROJECT_ROOT/$TARGET_DIR/"
    else
        echo "No documentation/ folder in this repo -- shipping README.md only."
    fi

    echo "Copying README.md to index.md..."
    if git show HEAD:README.md > "$PROJECT_ROOT/$TARGET_DIR/index.md" 2>/dev/null; then
        echo "README.md copied to index.md successfully"
    else
        echo "Warning: README.md not found in $REPO_URL"
        rm -f "$PROJECT_ROOT/$TARGET_DIR/index.md"
    fi

    cd "$PROJECT_ROOT"
    cleanup
    trap - EXIT
}

sync_repo "https://github.com/zen-fs/core.git" "core/kernel/public/initfs/usr/share/docs/@zenfs/core"
sync_repo "https://github.com/zen-fs/linux.git" "core/kernel/public/initfs/usr/share/docs/@zenfs/linux"

echo "ZenFS documentation sync completed!"

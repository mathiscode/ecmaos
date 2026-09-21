/**
 * `isomorphic-git` reads a global `Buffer`, which a browser worker does not have (Node, and so the
 * test environment, does). This module only installs it, and must be imported before the library:
 * ESM hoists imports, so the assignment has to live in its own module to run first.
 */

import { Buffer } from 'buffer'

globalThis.Buffer ??= Buffer

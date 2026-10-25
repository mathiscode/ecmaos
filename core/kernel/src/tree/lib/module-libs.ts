/**
 * The libraries the kernel runs on, which a module takes from the kernel (`ctx.import('lib:NAME')`) instead of bundling a
 * second copy: a filesystem type written against a copy of ZenFS of its own would be a different class from the one the
 * kernel checks. `module-libs.json` lists the names; the build of the in-tree modules reads it too, to know which imports to
 * leave to the kernel.
 */

import * as zenfsCore from '@zenfs/core'
import * as zenfsBackend from '@zenfs/core/backends/backend.js'
import * as zenfsConstants from '@zenfs/core/constants'
import * as zenfsMixins from '@zenfs/core/mixins/index.js'
import * as zenfsReadonly from '@zenfs/core/mixins/readonly.js'
import * as zenfsPath from '@zenfs/core/path'
import * as kerium from 'kerium'
import * as keriumLog from 'kerium/log'
import * as memium from 'memium'
import * as memiumDecorators from 'memium/decorators'
import * as utilium from 'utilium'
import * as utiliumBuffer from 'utilium/buffer'

import names from './module-libs.json'

export const PROVIDED_LIBS: Record<string, unknown> = {
  '@zenfs/core': zenfsCore,
  '@zenfs/core/backends/backend.js': zenfsBackend,
  '@zenfs/core/constants': zenfsConstants,
  '@zenfs/core/mixins/index.js': zenfsMixins,
  '@zenfs/core/mixins/readonly.js': zenfsReadonly,
  '@zenfs/core/path': zenfsPath,
  'kerium': kerium,
  'kerium/log': keriumLog,
  'memium': memium,
  'memium/decorators': memiumDecorators,
  'utilium': utilium,
  'utilium/buffer': utiliumBuffer
}

/** The names `module-libs.json` lists; a test keeps this and {@link PROVIDED_LIBS} the same */
export const LIB_NAMES: string[] = names

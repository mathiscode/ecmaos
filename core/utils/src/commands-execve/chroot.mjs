/** `chroot` cannot be done in a browser tab; it says why and fails, as the hard limits in the 1.0.0 plan call for. */

import { unsupported } from './lib/unsupported.mjs'

unsupported('chroot', 'there is no way to change the root directory here; every process sees the one filesystem')

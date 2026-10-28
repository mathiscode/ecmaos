/** `nsenter` cannot be done in a browser tab; it says why and fails, as the hard limits in the 1.0.0 plan call for. */

import { unsupported } from './lib/unsupported.mjs'

unsupported('nsenter', 'there are no namespaces here; each process is a worker, and the worker boundary is the isolation')

/* SPDX-License-Identifier: MIT OR Apache-2.0 */
#define SWAP_FLAG_PREFER 0x8000
#define SWAP_FLAG_PRIO_MASK 0x7fff
#define SWAP_FLAG_PRIO_SHIFT 0
#define SWAP_FLAG_DISCARD 0x10000
static inline int swapon(const char *p, int f) { (void)p; (void)f; return -1; }
static inline int swapoff(const char *p) { (void)p; return -1; }

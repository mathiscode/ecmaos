/* SPDX-License-Identifier: MIT OR Apache-2.0 */
#define ADDR_NO_RANDOMIZE 0x0040000
static inline int personality(unsigned long p) { (void)p; return -1; }

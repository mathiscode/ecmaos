/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Stands in for BSD <util.h> and <libutil.h>: what mg takes from them is declared in bsd.h (force-included). */
#include <stdio.h>
#define FPARSELN_UNESCESC 0x01
#define FPARSELN_UNESCCONT 0x02
#define FPARSELN_UNESCCOMM 0x04
#define FPARSELN_UNESCREST 0x08
char *fparseln(FILE *, size_t *, size_t *, const char[3], int);

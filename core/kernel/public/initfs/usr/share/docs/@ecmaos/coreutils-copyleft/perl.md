# perl

`man @ecmaos/coreutils-copyleft/perl`

## Synopsis

```
perl [-CDsTtuUWXc] [-hv] [-V[:configvar]] [-Mmodule] [-mmodule] [-e program] [-E program] [-Idir] [-l[octal]] [-0[octal]] [-a] [-F pattern] [-i[extension]] [-n] [-p] [-x] [--] [file] [arguments]
```

## Description

`perl` 5.44.0, built to WebAssembly and run as an ordinary program. It is the whole language: regular
expressions, `sprintf`, `sort`, formats, `local`, references, closures, `tie`, Unicode strings and I/O layers, and the
core modules (`strict`, `warnings`, `POSIX`, `List::Util`, `Data::Dumper`, `Storable`, `Digest::MD5`, `Digest::SHA`,
`Encode`, `Time::HiRes`, `Time::Piece`, `Socket`, `IO::Socket`, `File::Find`, `File::Temp`, `Getopt::Long`,
`HTTP::Tiny`, `JSON::PP`, `Test::More` and the rest). The library is in `/usr/lib/perl5/5.44.0`, unpacked beside the
program.

`fork`, `system`, backticks and pipe opens (`open(my $fh, '-|', ...)`) work, so a script can run other programs and wait
for them.

The extensions are linked into the program, as there is no `dlopen`: a module that needs a compiled part and is not
in the core set cannot be added, only one written in Perl (put it in `@INC` with `-I` or `use lib`). Left out:
`Compress::Raw::Zlib` and `Compress::Raw::Bzip2` (so `IO::Compress`, `IO::Zlib` and `Archive::Tar`'s compressed modes
do not work), `use re 'debug'`, threads, and the tools for building modules (`ExtUtils::*`, `CPAN`, `perldoc` and the
`.pod` documentation).

## Examples

```
perl -e 'print "hello\n"'
perl -ne 'print if /root/' /etc/passwd
perl -MList::Util=sum -le 'print sum(1..10)'
perl -MPOSIX=strftime -e 'print strftime("%F", gmtime), "\n"'
perl script.pl arg1 arg2
```

## See also

`@ecmaos/coreutils/lua`, `@ecmaos/coreutils/micropython`, `@ecmaos/coreutils-copyleft/make`

## License

Artistic-1.0-Perl OR GPL-1.0-or-later. The license texts and the offer of source are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/perl/`.

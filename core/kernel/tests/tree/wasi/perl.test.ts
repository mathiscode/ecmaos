import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/perl` is Perl built to WebAssembly (`core/utils-copyleft/wasm/perl/build.sh`), with its library in
 * /usr/lib/perl5/5.44.0 and the extensions linked in. It forks for system, backticks and pipe opens, so it is rewritten
 * with Asyncify.
 */
describe('perl', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
    // the program and its library are installed in the background; wait until it starts
    for (let tries = 0; tries < 100 && await kernel.shell.execute('perl -e "use strict; use POSIX" > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 300000)

  const run = async (script: string) => {
    await kernel.filesystem.fs.writeFile('/tmp/test.pl', script)
    const code = await kernel.shell.execute('perl /tmp/test.pl > /tmp/pl.out 2> /tmp/pl.err')
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/pl.out', 'utf8'),
      err: (await kernel.filesystem.fs.readFile('/tmp/pl.err', 'utf8')).trim()
    }
  }

  it('prints its version and runs a script that finds the library', async () => {
    expect(await run('use strict; use warnings; use Config; print "$]|$Config{archname}|@{[ scalar grep { $_ eq q{/usr/lib/perl5/5.44.0} } @INC ]}\\n";'))
      .toEqual({ code: 0, out: '5.044000|wasm32-linux|1\n', err: '' })
  }, 60000)

  it('has the extensions linked in: POSIX, List::Util, Data::Dumper, Digest::MD5, Digest::SHA, Storable, Time::HiRes, Encode, Socket, MIME::Base64', async () => {
    expect(await run(`use strict; use warnings;
use POSIX qw(floor strftime);
use List::Util qw(sum max first);
use Data::Dumper; $Data::Dumper::Sortkeys = 1; $Data::Dumper::Indent = 0;
use Digest::MD5 qw(md5_hex); use Digest::SHA qw(sha256_hex);
use Storable qw(freeze thaw); use Time::HiRes qw(time);
use Encode qw(encode decode); use Socket qw(inet_aton inet_ntoa); use MIME::Base64;
print join('|', floor(-1.5), sum(1..4), max(3, 9, 2), (first { $_ > 2 } 1..5),
  Dumper({ b => [1, 2], a => 'x' }), md5_hex('abc'), substr(sha256_hex('abc'), 0, 16),
  thaw(freeze({ n => 7 }))->{n}, (time() > 1e9 ? 'time' : 'no'),
  length(encode('UTF-8', "\\x{263a}")), inet_ntoa(inet_aton('127.0.0.1')), encode_base64('perl', ''),
  strftime('%Y', gmtime(0))), "\\n";`))
      .toEqual({ code: 0, out: "-2|10|9|3|$VAR1 = {'a' => 'x','b' => [1,2]};|900150983cd24fb0d6963f7d28e17f72|ba7816bf8f01cfea|7|time|3|127.0.0.1|cGVybA==|1970\n", err: '' })
  }, 60000)

  it('has the modules written in Perl: JSON::PP, Time::Piece, File::Temp, File::Find, Getopt::Long, HTTP::Tiny, IO::Socket, Test::More', async () => {
    expect(await run(`use strict; use warnings;
use JSON::PP; use Time::Piece; use File::Temp qw(tempfile); use File::Find; use File::Spec; use File::Basename;
use Getopt::Long qw(GetOptionsFromArray); use HTTP::Tiny; use IO::Socket::INET; use IO::File; use Cwd qw(getcwd);
use Test::More tests => 1;
my $json = JSON::PP->new->canonical->encode({ list => [1, 'two', undef], n => 1.5 });
my @args = ('--name=x', '-v', 'rest'); my ($name, $verbose);
GetOptionsFromArray(\\@args, 'name=s' => \\$name, 'v' => \\$verbose);
my ($fh, $file) = tempfile(DIR => '/tmp'); print $fh "x"; close $fh;
my @found; find(sub { push @found, $_ if $_ eq basename($file) }, '/tmp');
print "$json|$name$verbose|@args|", gmtime(86400)->ymd, '|', scalar(@found), '|', getcwd() ne '' ? 'cwd' : '', '|', HTTP::Tiny->new->agent =~ /^HTTP-Tiny/ ? 'tiny' : '', "\n";
ok(1, 'Test::More runs');`))
      .toEqual({ code: 0, out: '1..1\n{"list":[1,"two",null],"n":1.5}|x1|rest|1970-01-02|1|cwd|tiny\nok 1 - Test::More runs\n', err: '' })
  }, 60000)

  it('has regular expressions, `use re`, sprintf, sort, local and Unicode strings', async () => {
    expect(await run(`use strict; use warnings; use utf8; use re '/x'; binmode(STDOUT, ':utf8');
my $text = 'Alice=30, Bob=25, Carol=41';
my %age = $text =~ /(\\w+) = (\\d+)/gx;
my @sorted = sort { $age{$b} <=> $age{$a} or $a cmp $b } keys %age;
(my $swapped = 'héllo wörld') =~ s/(\\w+)/\\u$1/g;
printf "%s|%s|%05.1f|%s|%d\\n", "@sorted", $swapped, 3.14159, lc('ÀB'), length('日本語');`))
      .toEqual({ code: 0, out: 'Carol Alice Bob|Héllo Wörld|003.1|àb|3\n', err: '' })
  }, 60000)

  it('reads and writes files, opens a pipe, and runs system and backticks, which fork', async () => {
    expect(await run(`use strict; use warnings;
open(my $out, '>', '/tmp/perl-file') or die $!; print $out "one\\ntwo\\n"; close $out;
open(my $in, '<', '/tmp/perl-file') or die $!; my @lines = <$in>; close $in;
my $echo = \`echo from a shell\`; chomp $echo;
my $status = system('true');
open(my $pipe, '-|', 'echo', 'piped') or die $!; my $piped = <$pipe>; close $pipe; chomp $piped;
my $pid = fork(); if ($pid == 0) { exit 7 } waitpid($pid, 0);
print scalar(@lines), "|$echo|$status|$piped|", $? >> 8, "\\n";`))
      .toEqual({ code: 0, out: '2|from a shell|0|piped|7\n', err: '' })
  }, 60000)

  it('runs a one-liner from the shell and reads standard input', async () => {
    const code = await kernel.shell.execute("printf 'b\\na\\nc\\n' | perl -ne 'push @l, $_; END { print sort @l }' > /tmp/pl.out 2> /tmp/pl.err")
    expect(code, await kernel.filesystem.fs.readFile('/tmp/pl.err', 'utf8')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/pl.out', 'utf8')).toBe('a\nb\nc\n')
  }, 60000)
})

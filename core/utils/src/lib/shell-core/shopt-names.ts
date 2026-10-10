/** The `shopt` option names the shells know: the ones that change behavior, and the ones only remembered. */
export const SHOPT_EFFECTIVE = ['dotglob', 'extglob', 'failglob', 'globstar', 'nocaseglob', 'nocasematch', 'nullglob']
export const SHOPT_STORED = ['checkwinsize', 'cmdhist', 'histappend', 'huponexit', 'progcomp']
export const SHOPT_NAMES = [...SHOPT_EFFECTIVE, ...SHOPT_STORED].sort()

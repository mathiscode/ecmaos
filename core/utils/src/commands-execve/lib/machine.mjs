/** The machine name `uname -m` prints, from what the browser says of the processor it runs on. */

export async function machineName() {
  const data = await navigator.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness']).catch(() => undefined)
  const arch = data?.architecture
  const bits = data?.bitness
  if (arch === 'arm') return bits === '32' ? 'armv7l' : 'aarch64'
  if (arch === 'x86') return bits === '32' ? 'i686' : 'x86_64'
  const agent = String(navigator.userAgent ?? '')
  if (/aarch64|arm64/i.test(agent)) return 'aarch64'
  if (/\barm\b|armv/i.test(agent)) return 'armv7l'
  if (/i[3-6]86|\bx86(?!_64)\b/i.test(agent) && !/x86_64|Win64|x64/i.test(agent)) return 'i686'
  return 'x86_64'
}

/**
 * `/dev/rtc0` (and `/dev/rtc`, a link to it): the real-time clock, which here is the browser's clock. `RTC_RD_TIME` gives the
 * time in UTC as `struct rtc_time`, as a hardware clock kept in UTC does; `hwclock` reads it. The clock cannot be set
 * (`RTC_SET_TIME` is refused, as by a Linux driver with no `set_time`). `RTC_UIE_ON` turns on the update interrupt: a `read`
 * then waits for the next second to begin and gives an `unsigned long` (4 bytes here) of `RTC_UF | RTC_IRQF` and the count
 * of updates since the last read, in the upper bits; `RTC_UIE_OFF`, or the last close, turns it off. Alarms and periodic
 * interrupts are not there, so their requests are not understood (`ENOTTY`).
 *
 * `/sys/class/rtc/rtc0` has `name`, `date`, `time`, `since_epoch` and `hctosys`, as on Linux. A dynamic major, as Linux's rtc
 * class has.
 */

import { Class, EPOLLIN, EPOLLOUT, WaitQueue, current } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { fs } from '@zenfs/core'
import { withErrno } from 'kerium'
import type { KernelCharDevice, KernelDevice } from '@ecmaos/types'

// `<linux/rtc.h>`: `_IO('p', 3)`, `_IO('p', 4)`, `_IOR('p', 9, struct rtc_time)`, `_IOW('p', 10, struct rtc_time)`
export const RTC_UIE_ON = 0x7003
export const RTC_UIE_OFF = 0x7004
export const RTC_RD_TIME = 0x80247009
export const RTC_SET_TIME = 0x4024700a
export const RTC_IRQF = 0x80, RTC_UF = 0x10

/** `struct rtc_time`: nine ints, the fields of a `struct tm` in UTC */
export function rtcTime(date: Date): Uint8Array {
  const out = new Uint8Array(36)
  const view = new DataView(out.buffer)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const fields = [
    date.getUTCSeconds(), date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth(),
    date.getUTCFullYear() - 1900, date.getUTCDay(), Math.floor((date.getTime() - yearStart) / 86400000), 0
  ]
  fields.forEach((value, index) => view.setInt32(index * 4, value, true))
  return out
}

const rtc_class = new Class('rtc', {
  dev_attrs: {
    name: { mode: 0o444, show: () => 'rtc-browser\n' },
    date: { mode: 0o444, show: () => new Date().toISOString().slice(0, 10) + '\n' },
    time: { mode: 0o444, show: () => new Date().toISOString().slice(11, 19) + '\n' },
    since_epoch: { mode: 0o444, show: () => Math.floor(Date.now() / 1000) + '\n' },
    // the system clock is this clock, so it was set from it
    hctosys: { mode: 0o444, show: () => '1\n' }
  },
  dev_node: () => ({ mode: 0o600 })
})

/** The update interrupt: whether it is on, and the updates no read has taken yet */
const uie = { on: false, pending: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, queue: new WaitQueue() }

function nextUpdate() {
  uie.timer = setTimeout(() => {
    uie.pending++
    uie.queue.wake_up()
    nextUpdate()
  }, 1000 - (Date.now() % 1000))
  ;(uie.timer as { unref?: () => void }).unref?.()
}

function stopUpdates() {
  uie.on = false
  uie.pending = 0
  clearTimeout(uie.timer)
  uie.timer = undefined
}

export const rtcOperations: FileOperations = {
  release: () => stopUpdates(),
  read(_file, buffer, start, end) {
    if (end - start < 4) throw withErrno('EINVAL')
    // nothing pending: the read syscall waits on `poll_wait` until there is
    if (!uie.pending) return 0
    new DataView(buffer.buffer, buffer.byteOffset + start, 4).setUint32(0, ((uie.pending << 8) | RTC_UF | RTC_IRQF) >>> 0, true)
    uie.pending = 0
    return 4
  },
  write() { throw withErrno('EINVAL') },
  // writable, so a write is refused at once instead of waiting
  poll: () => (uie.pending ? EPOLLIN : 0) | EPOLLOUT,
  poll_wait: () => uie.queue,
  ioctl: {
    [RTC_RD_TIME]: () => rtcTime(new Date()),
    [RTC_SET_TIME]: () => {
      if (current?.context.credentials.euid !== 0) throw withErrno('EACCES')
      throw withErrno('EINVAL', "the browser's clock cannot be set")
    },
    [RTC_UIE_ON]: () => {
      if (uie.on) return
      uie.on = true
      uie.pending = 0
      nextUpdate()
    },
    [RTC_UIE_OFF]: () => stopUpdates()
  }
}

export const RtcDevice: KernelDevice = {
  pkg: { name: 'rtc', version: '0.1.0', description: 'The real-time clock (/dev/rtc0), which is the browser\'s clock' },
  async getDrivers(): Promise<KernelCharDevice[]> {
    // `/dev/rtc` is the name older programs open; the node itself is made once the drivers are registered
    void fs.promises.symlink('rtc0', '/dev/rtc').catch(() => { /* there already, or no /dev */ })
    return [{ name: 'rtc0', major: 0, minor: 0, class: rtc_class, ops: rtcOperations }]
  }
}

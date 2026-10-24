/// <reference types="w3c-web-hid" />

/**
 * A HID report descriptor made from what WebHID gives. A browser keeps the device's descriptor to itself and shows its
 * parsed collections, so `HIDIOCGRDESC` is answered with a descriptor written from them: the same collections, the same
 * reports and items, but not the bytes the device sent (the order of some items, the strings, and the `Push` and `Pop` it may
 * have used are gone). A program that parses it gets the same reports and fields.
 */

const Main = { input: 0x80, output: 0x90, feature: 0xb0, collection: 0xa0, end: 0xc0 }
const Global = { usagePage: 0x04, logicalMinimum: 0x14, logicalMaximum: 0x24, physicalMinimum: 0x34, physicalMaximum: 0x44, unitExponent: 0x54, unit: 0x64, reportSize: 0x74, reportId: 0x84, reportCount: 0x94 }
const Local = { usage: 0x08, usageMinimum: 0x18, usageMaximum: 0x28 }

/** An item: its prefix byte with the size of `value` in bytes (the least that holds it) and then the value, little-endian */
function item(prefix: number, value: number, signed = false): number[] {
  let size = 1
  if (signed) {
    if (value < -0x8000 || value > 0x7fff) size = 4
    else if (value < -0x80 || value > 0x7f) size = 2
  } else if (value > 0xffff) size = 4
  else if (value > 0xff) size = 2
  const bytes: number[] = [prefix | (size === 4 ? 3 : size)]
  for (let i = 0; i < size; i++) bytes.push((value >> (8 * i)) & 0xff)
  return bytes
}

/** The Unit item's value: the system in the lowest nibble, then the exponent of length, mass, time, temperature, current and luminous intensity */
const UnitSystems: Record<string, number> = { none: 0, 'si-linear': 1, 'si-rotation': 2, 'english-linear': 3, 'english-rotation': 4 }
function unitOf(source: HIDReportItem): number {
  const system = UnitSystems[source.unitSystem ?? 'none'] ?? 0
  if (!system) return 0
  const exponents = [source.unitFactorLengthExponent, source.unitFactorMassExponent, source.unitFactorTimeExponent, source.unitFactorTemperatureExponent, source.unitFactorCurrentExponent, source.unitFactorLuminousIntensityExponent]
  let unit = system
  exponents.forEach((exponent, i) => { unit |= ((exponent ?? 0) & 0xf) << (4 * (i + 1)) })
  return unit >>> 0
}

/** The flags of an Input, Output or Feature item */
function flagsOf(source: HIDReportItem, kind: 'input' | 'output' | 'feature'): number {
  let flags = 0
  if (source.isConstant) flags |= 1
  if (!source.isArray) flags |= 2
  if (source.isAbsolute === false) flags |= 4
  if (source.wrap) flags |= 8
  if (source.isLinear === false) flags |= 16
  if (source.hasPreferredState === false) flags |= 32
  if (source.hasNull) flags |= 64
  if (kind !== 'input' && source.isVolatile) flags |= 128
  if (source.isBufferedBytes) flags |= 256
  return flags
}

/** Whether any report the device has is numbered (its data begins with a report id); a device that is not has one report, id 0 */
export function usesReportIds(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some(collection =>
    [collection.inputReports, collection.outputReports, collection.featureReports].some(reports => reports?.some(report => (report.reportId ?? 0) !== 0)) ||
    usesReportIds(collection.children ?? []))
}

/** The report descriptor for a device's collections */
export function reportDescriptor(collections: readonly HIDCollectionInfo[]): Uint8Array {
  const out: number[] = []
  let page = -1

  const usagePage = (value: number) => {
    if (value === page) return
    page = value
    out.push(...item(Global.usagePage, value))
  }

  const emitItem = (source: HIDReportItem, kind: 'input' | 'output' | 'feature') => {
    const usages = source.usages ?? []
    if (source.isRange) {
      const minimum = source.usageMinimum ?? 0, maximum = source.usageMaximum ?? minimum
      usagePage(minimum >>> 16)
      out.push(...item(Local.usageMinimum, minimum & 0xffff), ...item(Local.usageMaximum, maximum & 0xffff))
    } else for (const usage of usages) {
      usagePage(usage >>> 16)
      out.push(...item(Local.usage, usage & 0xffff))
    }
    if (source.logicalMinimum !== undefined) out.push(...item(Global.logicalMinimum, source.logicalMinimum, true))
    if (source.logicalMaximum !== undefined) out.push(...item(Global.logicalMaximum, source.logicalMaximum, true))
    if (source.physicalMinimum !== undefined && (source.physicalMinimum !== 0 || source.physicalMaximum)) out.push(...item(Global.physicalMinimum, source.physicalMinimum, true))
    if (source.physicalMaximum !== undefined && (source.physicalMaximum !== 0 || source.physicalMinimum)) out.push(...item(Global.physicalMaximum, source.physicalMaximum, true))
    out.push(...item(Global.unitExponent, (source.unitExponent ?? 0) & 0xf), ...item(Global.unit, unitOf(source)))
    out.push(...item(Global.reportSize, source.reportSize ?? 0), ...item(Global.reportCount, source.reportCount ?? 0))
    out.push(...item(Main[kind], flagsOf(source, kind)))
  }

  const emitReports = (reports: readonly HIDReportInfo[] | undefined, kind: 'input' | 'output' | 'feature') => {
    for (const report of reports ?? []) {
      if ((report.reportId ?? 0) !== 0) out.push(...item(Global.reportId, report.reportId!))
      for (const source of report.items ?? []) emitItem(source, kind)
    }
  }

  const emit = (collection: HIDCollectionInfo) => {
    usagePage(collection.usagePage ?? 0)
    out.push(...item(Local.usage, collection.usage ?? 0), ...item(Main.collection, collection.type ?? 1))
    emitReports(collection.inputReports, 'input')
    emitReports(collection.outputReports, 'output')
    emitReports(collection.featureReports, 'feature')
    for (const child of collection.children ?? []) emit(child)
    out.push(Main.end)
  }

  for (const collection of collections) emit(collection)
  return Uint8Array.from(out)
}

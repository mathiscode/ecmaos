import { describe, expect, it } from 'vitest'

import { changeIds } from '#lib/process-credentials.ts'

const root = { real: 0, effective: 0, saved: 0 }
const user = { real: 1000, effective: 1000, saved: 1000 }
// a setuid program run by 1000: the owner is its effective and saved user
const elevated = { real: 1000, effective: 0, saved: 0 }

describe('changeIds', () => {
  it('lets root set all three with setuid, and any with setresuid', () => {
    expect(changeIds(root, true, 'id', 1000)).toEqual(user)
    expect(changeIds(root, true, 'res', 5, 6, 7)).toEqual({ real: 5, effective: 6, saved: 7 })
    expect(changeIds(root, true, 'res', -1, 1000, -1)).toEqual({ real: 0, effective: 1000, saved: 0 })
  })

  it('leaves an id whose argument is -1, or the same bits unsigned', () => {
    expect(changeIds(elevated, true, 'res', 0xFFFFFFFF, 1000, -1)).toEqual({ real: 1000, effective: 1000, saved: 0 })
  })

  it('lets an ordinary user take only an id it already holds', () => {
    expect(changeIds(user, false, 'id', 0)).toBeUndefined()
    expect(changeIds(user, false, 'res', -1, 0, -1)).toBeUndefined()
    expect(changeIds(user, false, 'res', -1, 1000, -1)).toEqual(user)
    expect(changeIds(user, false, 're', 0, -1)).toBeUndefined()
  })

  it('drops and regains privilege through the saved id, as a setuid program does', () => {
    const dropped = changeIds(elevated, true, 'res', -1, 1000, -1)!
    expect(dropped).toEqual({ real: 1000, effective: 1000, saved: 0 })
    expect(changeIds(dropped, false, 'id', 0)).toEqual({ ...dropped, effective: 0 })
    // setuid as the elevated program (effective root) is permanent: all three
    expect(changeIds(elevated, true, 'id', 1000)).toEqual(user)
  })

  it('sets the saved id with setreuid when the real id is set', () => {
    expect(changeIds(root, true, 're', 1000, 1000)).toEqual(user)
    expect(changeIds(user, false, 're', -1, 1000)).toEqual(user)
  })
})

const equipmentPrefix = 'VSU-EQUIPMENT:'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isConsumableShelf = shelf => shelf?.inventory_kind === 'consumable'
export const itemKind = (unit, shelf) => unit?.inventory_kind || shelf?.inventory_kind || 'equipment'
export const isConsumableUnit = (unit, shelf) => itemKind(unit, shelf) === 'consumable'

// A unit's database ID survives shelf changes and does not reuse local unit numbers.
export function equipmentQRValue(unit) {
  if (!uuidPattern.test(unit?.id || '')) throw new Error('This equipment unit needs a valid permanent ID.')
  return equipmentPrefix + unit.id.toLowerCase()
}

export function equipmentIdFromQR(value) {
  const code = String(value || '').trim()
  if (!code.startsWith(equipmentPrefix)) return null
  const id = code.slice(equipmentPrefix.length)
  if (!uuidPattern.test(id)) throw new Error('Invalid equipment QR code. Scan a generated equipment label.')
  return id.toLowerCase()
}

export async function resolveInventoryQR(client, value) {
  try {
    const code = String(value || '').trim()
    if (!code) throw new Error('Scan a QR code or enter its value.')
    const unitId = equipmentIdFromQR(code)
    if (unitId) {
      const { data: unit, error } = await client.from('inventory_units').select('*').eq('id', unitId).maybeSingle()
      if (error) throw error
      if (!unit || unit.retired_at) throw new Error('This equipment unit was removed or could not be found.')
      const { data: shelf, error: shelfError } = await client.from('shelves').select('*').eq('id', unit.shelf_id).eq('status', 'active').maybeSingle()
      if (shelfError) throw shelfError
      if (!shelf) throw new Error('The equipment shelf is no longer active.')
      if (isConsumableUnit(unit, shelf)) throw new Error('This stock is a consumable. Scan its shelf QR code.')
      return { data: { ...shelf, qr_kind: 'equipment', inventory_units: [unit] }, error: null }
    }
    const { data: shelf, error } = await client.from('shelves').select('*').eq('qr_value', code).eq('status', 'active').maybeSingle()
    if (error) throw error
    if (!shelf) throw new Error('No equipment or consumable shelf matches this QR code.')
    const units = []
    for (let offset = 0; ; offset += 500) {
      const { data, error: unitError } = await client.from('inventory_units').select('*').eq('shelf_id', shelf.id).order('unit_number').order('id').range(offset, offset + 499)
      if (unitError) throw unitError
      units.push(...data.filter(unit => !unit.retired_at && isConsumableUnit(unit, shelf)))
      if (data.length < 500) break
    }
    if (!units.length && !isConsumableShelf(shelf)) throw new Error('No consumables are available on this shelf. Scan the QR on the individual equipment unit for equipment.')
    return { data: { ...shelf, qr_kind: 'consumable', inventory_units: units }, error: null }
  } catch (error) { return { data: null, error } }
}

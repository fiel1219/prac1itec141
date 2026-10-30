const equipmentPrefix = 'VSU-EQUIPMENT:'
const consumablePrefix = 'VSU-CONSUMABLE:'
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

// Consumable stock rows can merge during condition checks. Their shared item
// number identifies the whole consumable on this shelf independently of rows.
export function consumableQRValue(shelf, unit) {
  if (!uuidPattern.test(shelf?.id || '') || !Number.isSafeInteger(unit?.consumable_number) || unit.consumable_number < 1) {
    throw new Error('This consumable needs a valid shelf ID and item reference.')
  }
  return `${consumablePrefix}${shelf.id.toLowerCase()}:${unit.consumable_number}`
}

export function consumableFromQR(value) {
  const code = String(value || '').trim()
  if (!code.startsWith(consumablePrefix)) return null
  const [shelfId, reference, ...extra] = code.slice(consumablePrefix.length).split(':')
  const number = Number(reference)
  if (!uuidPattern.test(shelfId || '') || !/^[1-9]\d*$/.test(reference || '') || !Number.isSafeInteger(number) || extra.length) {
    throw new Error('Invalid consumable QR code. Scan a generated consumable label.')
  }
  return { shelfId: shelfId.toLowerCase(), number }
}

export async function resolveInventoryQR(client, value) {
  try {
    const code = String(value || '').trim()
    if (!code) throw new Error('Scan a QR code or enter its value.')
    const consumable = consumableFromQR(code)
    const unitId = equipmentIdFromQR(code)
    if (unitId) {
      const { data: unit, error } = await client.from('inventory_units').select('*').eq('id', unitId).maybeSingle()
      if (error) throw error
      if (!unit || unit.retired_at) throw new Error('This equipment unit was removed or could not be found.')
      const { data: shelf, error: shelfError } = await client.from('shelves').select('*').eq('id', unit.shelf_id).eq('status', 'active').maybeSingle()
      if (shelfError) throw shelfError
      if (!shelf) throw new Error('The equipment shelf is no longer active.')
      if (isConsumableUnit(unit, shelf)) throw new Error('This stock is a consumable. Scan its consumable item QR or its shelf QR code.')
      return { data: { ...shelf, qr_kind: 'equipment', inventory_units: [unit] }, error: null }
    }
    const { data: shelf, error } = await client.from('shelves').select('*').eq(consumable ? 'id' : 'qr_value', consumable ? consumable.shelfId : code).eq('status', 'active').maybeSingle()
    if (error) throw error
    if (!shelf) throw new Error('No active or accessible shelf matches this QR code.')
    const units = []
    for (let offset = 0; ; offset += 500) {
      let query = client.from('inventory_units').select('*').eq('shelf_id', shelf.id)
      if (consumable) query = query.eq('consumable_number', consumable.number)
      const { data, error: unitError } = await query.order('unit_number').order('id').range(offset, offset + 499)
      if (unitError) throw unitError
      units.push(...data.filter(unit => !unit.retired_at && isConsumableUnit(unit, shelf)))
      if (data.length < 500) break
    }
    if (consumable) {
      if (!units.length) throw new Error('This consumable was removed or moved. Generate its current QR label from Items.')
      const name = unit => unit.item_name?.trim() || shelf.item_type?.trim() || 'Item'
      const names = new Set(units.map(unit => name(unit).toLowerCase()))
      if (names.size !== 1) throw new Error('This consumable reference matches multiple items. Correct its inventory records before issuing stock.')
      return { data: { ...shelf, qr_kind: 'consumable', qr_item_name: name(units[0]), inventory_units: units }, error: null }
    }
    if (!units.length && !isConsumableShelf(shelf)) throw new Error('No consumables are available on this shelf. Scan the QR on the individual equipment unit for equipment.')
    return { data: { ...shelf, qr_kind: 'consumable', inventory_units: units }, error: null }
  } catch (error) { return { data: null, error } }
}

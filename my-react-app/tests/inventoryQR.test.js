import { test } from 'node:test'
import assert from 'node:assert/strict'
import { equipmentQRValue, equipmentIdFromQR, resolveInventoryQR } from '../src/lib/inventoryQR.js'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

// Exercise the query predicates and pagination used against the Supabase tables.
function clientFor(tables, failure = null) {
  return { from(table) {
    let rows = [...(tables[table] || [])]
    const query = {
      select() { return query },
      eq(key, value) { rows = rows.filter(row => row[key] === value); return query },
      order() { return query },
      range(from, to) { rows = rows.slice(from, to + 1); return query },
      maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: failure }) },
      then(resolve, reject) { return Promise.resolve({ data: rows, error: failure }).then(resolve, reject) },
    }
    return query
  } }
}

test('equipment QR identifies a permanent unit independently of shelf and local numbering', () => {
  const unit = { id: firstId, shelf_id: 'A', unit_number: 1 }
  assert.equal(equipmentQRValue(unit), equipmentQRValue({ ...unit, shelf_id: 'B', unit_number: 9 }))
  assert.notEqual(equipmentQRValue(unit), equipmentQRValue({ ...unit, id: secondId }))
  assert.equal(equipmentIdFromQR(`  ${equipmentQRValue(unit)}  `), firstId)
  assert.equal(equipmentIdFromQR('SHELF-A-01'), null)
  assert.throws(() => equipmentIdFromQR('VSU-EQUIPMENT:invalid'), /Invalid equipment/)
})

test('scanning equipment returns only that unit, even when unit numbers repeat', async () => {
  const shelves = [{ id: 'A', inventory_kind: 'equipment', status: 'active' }, { id: 'B', inventory_kind: 'equipment', status: 'active' }]
  const units = [{ id: firstId, shelf_id: 'A', unit_number: 1 }, { id: secondId, shelf_id: 'B', unit_number: 1 }]
  const client = clientFor({ shelves, inventory_units: units })
  const response = await resolveInventoryQR(client, equipmentQRValue(units[1]))
  assert.equal(response.error, null)
  assert.equal(response.data.id, 'B')
  assert.equal(response.data.qr_kind, 'equipment')
  assert.deepEqual(response.data.inventory_units, [units[1]])
  // Moving a unit keeps its printed label valid and retrieves its current shelf.
  units[1].shelf_id = 'A'
  assert.equal((await resolveInventoryQR(client, equipmentQRValue(units[1]))).data.id, 'A')
})

test('retired units, archived shelves, and wrong label types cannot open equipment transactions', async () => {
  const unit = { id: firstId, shelf_id: 'A' }
  const shelf = { id: 'A', qr_value: 'SHELF-A', inventory_kind: 'equipment', status: 'active' }
  const client = clientFor({ shelves: [shelf], inventory_units: [unit] })
  assert.match((await resolveInventoryQR(client, 'SHELF-A')).error.message, /individual equipment/)
  unit.retired_at = '2026-10-23'
  assert.match((await resolveInventoryQR(client, equipmentQRValue(unit))).error.message, /removed/)
  unit.retired_at = null; shelf.status = 'archived'
  assert.match((await resolveInventoryQR(client, equipmentQRValue(unit))).error.message, /no longer active/)
  shelf.status = 'active'; shelf.inventory_kind = 'consumable'
  assert.match((await resolveInventoryQR(client, equipmentQRValue(unit))).error.message, /Scan its shelf QR/)
})

test('consumable shelf scans load all pages and exclude removed stock and other shelves', async () => {
  const shelf = { id: 'A', qr_value: 'EXISTING-SHELF-QR', inventory_kind: 'consumable', status: 'active' }
  const units = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), shelf_id: 'A', unit_number: i + 1 }))
  units[5].retired_at = '2026-10-23'
  units.push({ id: 'other', shelf_id: 'B' })
  const response = await resolveInventoryQR(clientFor({ shelves: [shelf], inventory_units: units }), ' EXISTING-SHELF-QR ')
  assert.equal(response.error, null)
  assert.equal(response.data.qr_kind, 'consumable')
  assert.equal(response.data.inventory_units.length, 1000)
  assert.equal(response.data.inventory_units.some(unit => unit.id === 'other' || unit.retired_at), false)
})

test('blank, unknown, malformed, and failed QR lookups return actionable errors', async () => {
  const client = clientFor({})
  for (const value of ['', 'unknown', 'VSU-EQUIPMENT:invalid', `VSU-EQUIPMENT:${firstId}`]) {
    const response = await resolveInventoryQR(client, value)
    assert.equal(response.data, null)
    assert.ok(response.error.message)
  }
  const failure = new Error('Network unavailable')
  assert.equal((await resolveInventoryQR(clientFor({}, failure), 'SHELF')).error, failure)
})

test('mixed shelf labels expose only consumables and equipment QR follows the item category', async () => {
  const shelf = { id:'A',qr_value:'MIXED',status:'active',inventory_kind:'consumable' }
  const equipment = { id:firstId,shelf_id:'A',inventory_kind:'equipment',item_name:'Cable' }
  const consumable = { id:secondId,shelf_id:'A',inventory_kind:'consumable',item_name:'Cable' }
  const client = clientFor({ shelves:[shelf],inventory_units:[equipment,consumable] })
  assert.deepEqual((await resolveInventoryQR(client,'MIXED')).data.inventory_units,[consumable])
  assert.deepEqual((await resolveInventoryQR(client,equipmentQRValue(equipment))).data.inventory_units,[equipment])
  assert.match((await resolveInventoryQR(client,equipmentQRValue(consumable))).error.message,/Scan its shelf QR/)
  shelf.inventory_kind='equipment'
  assert.deepEqual((await resolveInventoryQR(client,'MIXED')).data.inventory_units,[consumable])
})

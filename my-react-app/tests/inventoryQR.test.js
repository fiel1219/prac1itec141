import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumableQRValue, consumableFromQR, equipmentQRValue, equipmentIdFromQR, resolveInventoryQR } from '../src/lib/inventoryQR.js'

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
  assert.match((await resolveInventoryQR(client, equipmentQRValue(unit))).error.message, /Scan its consumable item QR/)
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
  assert.match((await resolveInventoryQR(client,equipmentQRValue(consumable))).error.message,/Scan its consumable item QR/)
  shelf.inventory_kind='equipment'
  assert.deepEqual((await resolveInventoryQR(client,'MIXED')).data.inventory_units,[consumable])
})

test('consumable labels identify each item on its shelf and survive stock row replacement', () => {
  const shelf = { id: firstId }, stock = { id: secondId, consumable_number: 1 }
  const qr = consumableQRValue(shelf, stock)
  assert.deepEqual(consumableFromQR(` ${qr} `), { shelfId: firstId, number: 1 })
  assert.equal(consumableQRValue(shelf, { ...stock, id: firstId, quantity: 12, condition: 'damaged' }), qr)
  assert.notEqual(consumableQRValue(shelf, { ...stock, consumable_number: 2 }), qr)
  assert.notEqual(consumableQRValue({ id: secondId }, stock), qr)
  assert.equal(consumableFromQR('OLD-SHELF-QR'), null)
  for (const suffix of [`${firstId}:0`, `${firstId}:-1`, `${firstId}:1.2`, `${firstId}:1:extra`, `${firstId}:9007199254740992`, 'invalid:1']) {
    assert.throws(() => consumableFromQR(`VSU-CONSUMABLE:${suffix}`), /Invalid consumable/)
  }
  assert.throws(() => consumableQRValue(shelf, {}), /item reference/)
})

test('consumable item scan returns all its stock states without other consumables or equipment', async () => {
  const shelf = { id: firstId, status: 'active', inventory_kind: 'equipment' }
  const units = [
    { id: 'a', shelf_id: firstId, consumable_number: 1, inventory_kind: 'consumable', item_name: 'Cable ties', quantity: 50 },
    { id: 'b', shelf_id: firstId, consumable_number: 1, inventory_kind: 'consumable', item_name: 'cable ties', quantity: 5, condition: 'damaged' },
    { id: 'c', shelf_id: firstId, consumable_number: 2, inventory_kind: 'consumable', item_name: 'Gloves', quantity: 100 },
    { id: 'd', shelf_id: firstId, consumable_number: 1, inventory_kind: 'equipment', item_name: 'Cable ties' },
    { id: 'e', shelf_id: secondId, consumable_number: 1, inventory_kind: 'consumable', item_name: 'Cable ties' },
    { id: 'f', shelf_id: firstId, consumable_number: 1, inventory_kind: 'consumable', item_name: 'Old stock', retired_at: '2026-10-30' },
  ]
  const client = clientFor({ shelves: [shelf], inventory_units: units })
  const code = consumableQRValue(shelf, units[0])
  const result = await resolveInventoryQR(client, code)
  assert.equal(result.error, null)
  assert.equal(result.data.qr_item_name, 'Cable ties')
  assert.equal(result.data.qr_kind, 'consumable')
  assert.deepEqual(result.data.inventory_units, units.slice(0, 2))
  units.splice(0, 1) // Stock checks can merge/delete the original record.
  assert.deepEqual((await resolveInventoryQR(client, code)).data.inventory_units, [units[0]])
})

test('consumable scan rejects moved, deleted, archived, conflicting or inaccessible stock', async () => {
  const shelf = { id: firstId, status: 'active' }
  const unit = { id: secondId, shelf_id: firstId, consumable_number: 1, inventory_kind: 'consumable', item_name: 'Gloves' }
  const tables = { shelves: [shelf], inventory_units: [unit] }
  const code = consumableQRValue(shelf, unit), client = clientFor(tables)
  unit.shelf_id = secondId
  assert.match((await resolveInventoryQR(client, code)).error.message, /removed or moved/)
  unit.shelf_id = firstId; unit.retired_at = '2026-10-30'
  assert.match((await resolveInventoryQR(client, code)).error.message, /removed or moved/)
  unit.retired_at = null; shelf.status = 'archived'
  assert.match((await resolveInventoryQR(client, code)).error.message, /active or accessible/)
  shelf.status = 'active'
  tables.inventory_units.push({ ...unit, id: 'different', item_name: 'Wipes' })
  assert.match((await resolveInventoryQR(client, code)).error.message, /multiple items/)
  const failure = new Error('Permission denied')
  assert.equal((await resolveInventoryQR(clientFor(tables, failure), code)).error, failure)
})

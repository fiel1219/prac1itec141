import { loadPagedRows } from './queryData.js'

// Select all columns so older databases can still load inventory before migration.
export async function loadInventoryUnits(client, shelfId) {
  const units = []
  for (let offset = 0; ; offset += 500) {
    let request = client.from('inventory_units').select('*').order('unit_number').order('id').range(offset, offset + 499)
    if (shelfId) request = request.eq('shelf_id', shelfId)
    const { data, error } = await request
    if (error) return { data: null, error }
    units.push(...data.filter(unit => !unit.retired_at))
    if (data.length < 500) break
  }
  return { data: units, error: null }
}

export async function loadTransactions(client, activeOnly = false, laboratoryId = null) {
  const rows = []
  for (let offset = 0; ; offset += 500) {
    let request = client.from('transactions').select('*, borrowers(name, identity_number), inventory_units(unit_number, shelf_id, shelves(code, name, item_type))')
      .order('borrowed_at', { ascending: false }).order('id').range(offset, offset + 499)
    if (activeOnly) request = request.is('returned_at', null)
    if (laboratoryId) request = request.eq('laboratory_id',laboratoryId)
    const { data, error } = await request
    if (error) return { data: null, error }
    rows.push(...data)
    if (data.length < 500) break
  }
  return { data: rows, error: null }
}

export async function inventoryMigrationRequired(client) {
  const checks = await Promise.all([
    client.from('shelves').select('low_stock_threshold').limit(0),
    client.from('shelves').select('inventory_kind').limit(0),
    client.from('inventory_units').select('retired_at').limit(0),
    client.from('stock_movements').select('id').limit(0),
  ])
  let required = false
  for (const { error } of checks) {
    if (!error) continue
    if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) required = true
    else return { required: false, error }
  }
  const [{ error: unitActionsError }, { error: permanentDeleteError }] = await Promise.all([
    client.from('shelves').select('next_unit_number').limit(0),
    client.from('stock_movements').select('unit_id_snapshot').limit(0),
  ])
  if (unitActionsError && !['42703', '42P01', 'PGRST204', 'PGRST205'].includes(unitActionsError.code)) {
    return { required, error: unitActionsError }
  }
  if (permanentDeleteError && !['42703', '42P01', 'PGRST204', 'PGRST205'].includes(permanentDeleteError.code)) {
    return { required, error: permanentDeleteError }
  }
  return { required, unitActionsRequired: Boolean(unitActionsError), permanentDeleteRequired: Boolean(permanentDeleteError), error: null }
}

export async function inventoryItemNamesRequired(client) {
  const { error } = await client.from('inventory_units').select('item_name').limit(0)
  if (!error) return { required: false, error: null }
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) return { required: true, error: null }
  return { required: false, error }
}

export async function inventoryItemCategoriesRequired(client) {
  const checks = await Promise.all([
    client.from('inventory_units').select('inventory_kind').limit(0),
    client.from('shelves').select('description').limit(0),
    client.from('inventory_units').select('quantity,consumable_number').limit(0),
  ])
  let required = false
  for (const { error } of checks) {
    if (!error) continue
    if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) required = true
    else return { required: false, error }
  }
  return { required, error: null }
}



const setupCache = new WeakMap()
export function loadInventorySetup(client, now = Date.now()) {
  const cached = setupCache.get(client)
  if (cached && cached.expiresAt > now) return cached.promise
  const entry = { expiresAt: Infinity }
  entry.promise = Promise.all([inventoryMigrationRequired(client), inventoryItemNamesRequired(client), inventoryItemCategoriesRequired(client)])
    .then(([inventory, names, categories]) => {
      const error = inventory.error || names.error || categories.error
      const result = { migrationRequired: inventory.required, unitActionsRequired: inventory.unitActionsRequired,
        permanentDeleteRequired: inventory.permanentDeleteRequired, itemNamesRequired: names.required,
        itemCategoriesRequired: categories.required, error: error || null }
      if (setupCache.get(client) === entry) {
        if (!error && !Object.entries(result).some(([key, value]) => key !== 'error' && value)) entry.expiresAt = now + 300000
        else setupCache.delete(client)
      }
      return result
    }).catch(error => { if (setupCache.get(client) === entry) setupCache.delete(client); throw error })
  setupCache.set(client, entry)
  return entry.promise
}

export async function loadShelfInventory(client) {
  const [shelves, units, setup] = await Promise.all([
    loadPagedRows(client, 'shelves', { orders: [['code'], ['id']], filters: [['status', 'active']] }),
    loadInventoryUnits(client), loadInventorySetup(client),
  ])
  const error = shelves.error || units.error || setup.error
  if (error) return { data: null, error }
  const grouped = new Map()
  for (const unit of units.data) {
    if (!grouped.has(unit.shelf_id)) grouped.set(unit.shelf_id, [])
    grouped.get(unit.shelf_id).push(unit)
  }
  return { ...setup, data: shelves.data.map(shelf => ({ ...shelf, inventory_units: grouped.get(shelf.id) || [] })), error: null }
}

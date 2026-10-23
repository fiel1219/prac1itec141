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

export async function loadTransactions(client, activeOnly = false) {
  const rows = []
  for (let offset = 0; ; offset += 500) {
    let request = client.from('transactions').select('*, borrowers(name, identity_number), inventory_units(unit_number, shelf_id, shelves(code, name, item_type))')
      .order('borrowed_at', { ascending: false }).order('id').range(offset, offset + 499)
    if (activeOnly) request = request.is('returned_at', null)
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
  const { error: unitActionsError } = await client.from('shelves').select('next_unit_number').limit(0)
  if (unitActionsError && !['42703', '42P01', 'PGRST204', 'PGRST205'].includes(unitActionsError.code)) {
    return { required, error: unitActionsError }
  }
  const { error: permanentDeleteError } = await client.from('stock_movements').select('unit_id_snapshot').limit(0)
  if (permanentDeleteError && !['42703', '42P01', 'PGRST204', 'PGRST205'].includes(permanentDeleteError.code)) {
    return { required, error: permanentDeleteError }
  }
  return { required, unitActionsRequired: Boolean(unitActionsError), permanentDeleteRequired: Boolean(permanentDeleteError), error: null }
}

import { activeUnits, itemName, recordQuantity } from './inventory.js'
import { laboratoryRoles } from './userLaboratories.js'

export function canCheckInventory(user, assignments, laboratoryId) {
  return user?.status === 'active' && Boolean(laboratoryId) && assignments.some(row =>
    row.user_id === user.id && row.laboratory_id === laboratoryId && laboratoryRoles.includes(row.role))
}

export function inspectionItems(shelf) {
  return activeUnits(shelf).map(unit => ({ ...unit, check_quantity: recordQuantity(unit, shelf),
    skip_reason: unit.status === 'borrowed' ? 'On loan — inspect after return'
      : ['missing', 'not_found'].includes(unit.status) ? 'Not on shelf — resolve its status first'
        : recordQuantity(unit, shelf) === 0 ? 'No stock to inspect' : '',
  })).sort((a, b) => itemName(a, shelf).localeCompare(itemName(b, shelf)) || a.unit_number - b.unit_number)
}

export function checkSubmission(items, findings) {
  return items.filter(item => !item.skip_reason).map(item => ({
    unit_id: item.id, expected_status: item.status, expected_condition: item.condition,
    expected_quantity: item.check_quantity, condition: findings[item.id]?.condition || '',
    notes: (findings[item.id]?.notes || '').trim(),
  }))
}

export async function loadInventoryChecks(client, laboratoryId, shelfId) {
  let request = client.from('inventory_checks')
    .select('id,shelf_id,shelf_id_snapshot,shelf_code,shelf_name,performed_by,checked_at,present_units,damaged_units,skipped_units,comments,item_results')
    .eq('laboratory_id', laboratoryId)
  if (shelfId) request = request.eq('shelf_id_snapshot', shelfId)
  const result = await request.order('checked_at', { ascending: false }).order('id').limit(10)
  if (result.error && ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(result.error.code)) return { data: [], setupRequired: true, error: null }
  return result
}

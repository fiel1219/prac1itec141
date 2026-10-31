import { activeUnits, itemName, recordQuantity } from './inventory.js'
import { navigationPages } from './navigationAccess.js'
import { itemKind } from './inventoryQR.js'

export function canCheckInventory(user, assignments, laboratoryId) {
  return navigationPages(user, assignments, laboratoryId).includes('Inventory Checks')
}

export function inspectionItems(shelf) {
  return activeUnits(shelf).map(unit => ({ ...unit, inventory_kind: itemKind(unit, shelf), check_quantity: recordQuantity(unit, shelf),
    skip_reason: unit.status === 'borrowed' ? 'On loan — inspect after return'
      : ['missing', 'not_found'].includes(unit.status) ? 'Not on shelf — resolve its status first'
        : '',
  })).sort((a, b) => itemName(a, shelf).localeCompare(itemName(b, shelf)) || a.unit_number - b.unit_number)
}

export function countedQuantity(item, finding) {
  if (finding?.count_result === 'matches') return item.check_quantity
  if (finding?.count_result !== 'different' || String(finding.actual_quantity ?? '').trim() === '') return null
  const count = Number(finding.actual_quantity)
  return Number.isSafeInteger(count) && count >= 0 && count <= 2147483647 ? count : null
}

export function isInspectionReviewed(item, finding) {
  if (item.skip_reason) return false
  if (item.inventory_kind !== 'consumable') return ['good', 'damaged'].includes(finding?.condition)
  const actual = countedQuantity(item, finding)
  return actual !== null && (finding.count_result === 'matches' ? actual === item.check_quantity : actual !== item.check_quantity)
}

export function quantityDifferenceLabel(actual, recorded) {
  const difference = actual - recorded
  return difference === 0 ? 'Matches record' : `${Math.abs(difference)} ${difference < 0 ? 'short' : 'extra'}`
}

export function inspectionResultText(item) {
  if (item.skipped) return `Skipped (${(item.previous_status || 'unavailable').replaceAll('_', ' ')}) · recorded quantity ${item.quantity}`
  if (item.inventory_kind === 'consumable' && item.count_result) {
    return `Recorded ${item.expected_quantity} · Counted ${item.actual_quantity} · ${quantityDifferenceLabel(item.actual_quantity, item.expected_quantity)}`
  }
  return `${item.condition === 'good' ? 'Good' : 'Damaged'} · quantity ${item.quantity}`
}

export function checkSubmission(items, findings) {
  return items.filter(item => !item.skip_reason).map(item => ({
    unit_id: item.id, expected_status: item.status, expected_condition: item.condition,
    expected_quantity: item.check_quantity, expected_inventory_kind: item.inventory_kind, condition: findings[item.id]?.condition || '',
    ...(item.inventory_kind === 'consumable' ? { count_result: findings[item.id]?.count_result || '', actual_quantity: countedQuantity(item, findings[item.id]) } : {}),
    notes: (findings[item.id]?.notes || '').trim(),
  }))
}

export async function loadInventoryChecks(client, laboratoryId, shelfId) {
  let request = client.from('inventory_checks')
    .select('id,shelf_id,shelf_id_snapshot,shelf_code,shelf_name,performed_by,checked_at,present_units,damaged_units,skipped_units,quantity_discrepancies,comments,item_results')
    .eq('laboratory_id', laboratoryId)
  if (shelfId) request = request.eq('shelf_id_snapshot', shelfId)
  const result = await request.order('checked_at', { ascending: false }).order('id').limit(10)
  if (result.error && ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(result.error.code)) return { data: [], setupRequired: true, error: null }
  return result
}

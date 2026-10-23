import { itemKind } from './inventoryQR.js'

export const activeUnits = shelf => (shelf.inventory_units || []).filter(unit => !unit.retired_at)
export const availableUnits = shelf => activeUnits(shelf).filter(unit => unit.status === 'available' && unit.condition === 'good')
export const recordQuantity = (unit, shelf) => itemKind(unit, shelf) === 'consumable' ? Number(unit.quantity ?? 1) : 1
export const stockQuantity = shelf => activeUnits(shelf).reduce((total,unit) => total + recordQuantity(unit,shelf),0)
export const availableQuantity = shelf => availableUnits(shelf).reduce((total,unit) => total + recordQuantity(unit,shelf),0)
export const itemLabel = (unit, shelf) => `${itemKind(unit,shelf) === 'consumable' ? 'Consumable' : 'Equipment'} ${String(itemKind(unit,shelf) === 'consumable' ? unit.consumable_number ?? unit.unit_number : unit.unit_number).padStart(3,'0')}`
export const isLowStock = shelf => availableQuantity(shelf) <= Number(shelf.low_stock_threshold ?? 2)
export const itemName = (unit, shelf) => unit?.item_name?.trim() || shelf?.item_type?.trim() || 'Item'
export function shelfItems(shelf) {
  const groups = new Map()
  for (const unit of activeUnits(shelf)) {
    const name = itemName(unit, shelf), kind = itemKind(unit, shelf), key = `${kind}:${name.toLowerCase()}`
    if (!groups.has(key)) groups.set(key, { key, name, kind, units: [] })
    groups.get(key).units.push(unit)
  }
  return [...groups.values()].map(group => ({ ...group, quantity: stockQuantity({ ...shelf, inventory_units: group.units }),
    available: availableQuantity({ ...shelf, inventory_units: group.units }) })).sort((a,b) => a.name.localeCompare(b.name))
}

export function inventorySummary(shelves) {
  return shelves.flatMap(shelf => {
    const groups = shelfItems(shelf)
    return (groups.length ? groups : [{ name: '', units: [] }]).map(group => {
      const units = group.units, subset = { ...shelf, inventory_units: units }
      return {
        code: shelf.code, name: shelf.name, item_type: group.name, inventory_kind: group.kind || '', category: group.kind === 'consumable' ? 'Consumables' : group.kind === 'equipment' ? 'Equipment' : '',
        total: stockQuantity(subset), available: availableQuantity(subset),
        borrowed: units.filter(unit => unit.status === 'borrowed').reduce((sum,unit) => sum + recordQuantity(unit,shelf),0),
        damaged: units.filter(unit => unit.condition === 'damaged').reduce((sum,unit) => sum + recordQuantity(unit,shelf),0),
        maintenance: units.filter(unit => unit.status === 'under_maintenance').reduce((sum,unit) => sum + recordQuantity(unit,shelf),0),
        missing: units.filter(unit => ['missing', 'not_found'].includes(unit.status)).reduce((sum,unit) => sum + recordQuantity(unit,shelf),0),
        threshold: shelf.low_stock_threshold ?? 2, low_stock: isLowStock(subset) ? 'Yes' : 'No',
      }
    })
  })
}

export function csvText(headers, rows) {
  const cell = value => {
    let text = String(value ?? '')
    // Spreadsheet applications can execute formulas in imported CSV cells.
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n')
}

export function downloadCsv(filename, headers, rows) {
  const url = URL.createObjectURL(new Blob(['\ufeff', csvText(headers, rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

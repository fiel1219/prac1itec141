export const activeUnits = shelf => (shelf.inventory_units || []).filter(unit => !unit.retired_at)
export const availableUnits = shelf => activeUnits(shelf).filter(unit => unit.status === 'available' && unit.condition === 'good')
export const isLowStock = shelf => availableUnits(shelf).length <= Number(shelf.low_stock_threshold ?? 2)

export function inventorySummary(shelves) {
  return shelves.map(shelf => {
    const units = activeUnits(shelf)
    return {
      code: shelf.code, name: shelf.name, item_type: shelf.item_type,
      total: units.length, available: availableUnits(shelf).length,
      borrowed: units.filter(unit => unit.status === 'borrowed').length,
      damaged: units.filter(unit => unit.condition === 'damaged').length,
      maintenance: units.filter(unit => unit.status === 'under_maintenance').length,
      missing: units.filter(unit => ['missing', 'not_found'].includes(unit.status)).length,
      threshold: shelf.low_stock_threshold ?? 2, low_stock: isLowStock(shelf) ? 'Yes' : 'No',
    }
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

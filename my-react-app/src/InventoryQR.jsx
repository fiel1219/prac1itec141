import { useEffect, useRef, useState } from 'react'
import { fetchBorrowers, fetchInventoryByQR, supabase } from './lib/supabase'
import { activeUnits, availableUnits, stockQuantity, itemName, itemLabel, shelfItems } from './lib/inventory'
import { consumableQRValue, equipmentQRValue, isConsumableUnit } from './lib/inventoryQR'
import { defaultReturnDate, localDateValue } from './lib/dates'
import './InventoryQR.css'

const unitName = unit => `Equipment ${String(unit.unit_number).padStart(3, '0')}`

function QRLabel({ shelf, unit }) {
  const [generated, setGenerated] = useState(null), [failure, setFailure] = useState(null)
  const consumable = isConsumableUnit(unit, shelf)
  const value = consumable ? consumableQRValue(shelf, unit) : equipmentQRValue(unit)
  const image = generated?.value === value ? generated.image : ''
  const error = failure?.value === value ? failure.message : ''
  useEffect(() => {
    let cancelled = false
    import('qrcode').then(({default: QRCode}) => QRCode.toDataURL(value, { width: 520, margin: 4 })).then(result => {
      if (!cancelled) { setGenerated({ value, image: result }); setFailure(null) }
    }).catch(error => { if (!cancelled) setFailure({ value, message: error.message }) })
    return () => { cancelled = true }
  }, [value])
  function download() {
    const link = document.createElement('a')
    link.href = image
    link.download = consumable ? `${shelf.code}-consumable-${unit.consumable_number}-qr.png` : `equipment-${unit.id}-qr.png`
    link.click()
  }
  return <><span className="eyebrow">{consumable ? 'CONSUMABLE ITEM QR CODE' : 'EQUIPMENT QR CODE'}</span>
    <h2>{`${itemName(unit, shelf)} · ${itemLabel(unit, shelf)}`}</h2>
    <p>{shelf.name} · {shelf.code}{!consumable && ` · Permanent ID: ${unit.id}`}</p>
    {consumable && <p>Scan to issue this consumable directly. Generate a new label after moving it to another shelf.</p>}
    {unit?.description && <p className="item-description">{unit.description}</p>}
    {image ? <img className="qr-image" src={image} alt={`QR code for ${itemName(unit, shelf)} · ${itemLabel(unit, shelf)}`}/> : !error && <p>Generating QR…</p>}
    {error && <div role="alert" className="connection-error">{error}</div>}
    <code className="qr-value">{value}</code>
    <button className="primary full" onClick={download} disabled={!image}>Download QR</button></>
}

export function InventoryLabels({ shelf, shelves = [], close, onChange, canOperate = false, canManage = false, migrationRequired = false, unitActionsRequired = false, permanentDeleteRequired = false, itemNamesRequired = false, itemCategoriesRequired = false }) {
  const [unitId, setUnitId] = useState(shelf.qrUnit?.id || null)
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('')
  const [action, setAction] = useState(null), [destinationId, setDestinationId] = useState(''), [reason, setReason] = useState('')
  const [consumableAction, setConsumableAction] = useState(null)
  const [selectedKeys, setSelectedKeys] = useState([]), [bulkAction, setBulkAction] = useState(null)
  const [savingUnit, setSavingUnit] = useState(false), [unitError, setUnitError] = useState(''), [success, setSuccess] = useState('')
  const [removedIds, setRemovedIds] = useState([])
  const [unitOverrides, setUnitOverrides] = useState({})
  const [returnLoans, setReturnLoans] = useState([]), [returnLoanId, setReturnLoanId] = useState('')
  const [returnCondition, setReturnCondition] = useState('good'), [physicalReturn, setPhysicalReturn] = useState(false), [loadingReturn, setLoadingReturn] = useState(false)
  const [addingItems, setAddingItems] = useState(false), [quantity, setQuantity] = useState(1)
  const [savingStock, setSavingStock] = useState(false), [stockError, setStockError] = useState('')
  const [stockItem, setStockItem] = useState('')
  const [description, setDescription] = useState('')
  const [inventoryKind, setInventoryKind] = useState('equipment')
  const body = useRef(null)
  const units = activeUnits(shelf).filter(item => !removedIds.includes(item.id)).map(item => ({ ...item,
    ...(unitOverrides[item.id]?.source === shelf.inventory_units ? unitOverrides[item.id].values : {}) }))
  const unit = units.find(item => item.id === unitId)
  const actionUnit = (action?.type === 'return' ? !canOperate : !canManage) ? null : units.find(item => item.id === action?.id)
  const equipmentUnits = units.filter(item => !isConsumableUnit(item, shelf))
  const consumableItems = shelfItems({ ...shelf, inventory_units: units.filter(item => isConsumableUnit(item, shelf)) })
  const actionConsumable = canManage && consumableItems.find(item => item.key === consumableAction?.key)
  const destinations = shelves.filter(item => item.id !== shelf.id && item.status === 'active')
  const hasStock = stockQuantity({ ...shelf,inventory_units:units }) > 0
  const busy = deleting || savingUnit || loadingReturn || savingStock
  const actionsUnavailable = migrationRequired || unitActionsRequired || itemCategoriesRequired
  const selectableEquipment = equipmentUnits.filter(item => item.status !== 'borrowed')
  const selectableConsumables = consumableItems.filter(item => item.units.every(unit => unit.status !== 'borrowed'))
  const selectableKeys = [...selectableEquipment.map(item => `equipment:${item.id}`), ...selectableConsumables.map(item => item.key)]
  const selectedEquipment = selectableEquipment.filter(item => selectedKeys.includes(`equipment:${item.id}`))
  const selectedConsumables = selectableConsumables.filter(item => selectedKeys.includes(item.key))
  const selectedCount = selectedEquipment.length + selectedConsumables.length
  const selectionDisabled = !canManage || busy || actionsUnavailable || !!bulkAction
  const deleteShelfHelp = migrationRequired ? 'Complete the database setup to delete shelves.' : permanentDeleteRequired ? 'Complete the permanent deletion database update shown on the main page.' : hasStock ? 'Move or delete the remaining items to empty this shelf. Return borrowed equipment first.' : ''
  function requestClose() { if (!busy) close() }
  function openUnitAction(type, item) {
    if (type === 'return' ? !canOperate : !canManage) return
    setBulkAction(null)
    setAddingItems(false); setStockError(''); setConsumableAction(null)
    setAction({ type, id: item.id }); setDestinationId(''); setReason(''); setUnitError(''); setSuccess(''); setUnitId(null)
    body.current?.scrollTo({ top: 0 })
  }
  function openAddItems() {
    if (!canManage) return
    setBulkAction(null); setSelectedKeys([])
    setStockItem(''); setDescription(''); setInventoryKind('equipment'); setConsumableAction(null)
    setAddingItems(true); setQuantity(1); setStockError(''); setSuccess(''); setAction(null); setUnitId(null); setUnitError(''); setDeleteError('')
    body.current?.scrollTo({ top: 0 })
  }
  function openConsumableAction(type, item) {
    if (!canManage) return
    setBulkAction(null)
    setConsumableAction({ type, key:item.key }); setAction(null); setUnitId(null)
    setDestinationId(''); setReason(''); setUnitError(''); setSuccess(''); setStockError('')
    body.current?.scrollTo({ top:0 })
  }
  function toggleSelection(key) {
    if (selectionDisabled) return
    setSelectedKeys(previous => previous.includes(key) ? previous.filter(value => value !== key) : [...previous,key])
  }
  function openBulkAction(type) {
    if (!canManage || busy || actionsUnavailable || !selectedCount || (type === 'delete' && permanentDeleteRequired)) return
    setBulkAction({ type, equipment:selectedEquipment, consumables:selectedConsumables })
    setAction(null); setConsumableAction(null); setUnitId(null)
    setDestinationId(''); setReason(''); setUnitError(''); setSuccess(''); setStockError('')
    body.current?.scrollTo({ top:0 })
  }
  async function saveBulkAction(event) {
    event.preventDefault()
    if (!canManage || busy || !bulkAction || actionsUnavailable || (bulkAction.type === 'delete' && permanentDeleteRequired)) return
    const destination = destinations.find(item => item.id === destinationId)
    setUnitError(''); setSuccess('')
    if (bulkAction.type === 'move' && !destination) { setUnitError('Choose a destination shelf.'); return }
    if (bulkAction.type === 'delete' && !reason.trim()) { setUnitError('Enter a deletion reason.'); return }
    setSavingUnit(true)
    try {
      const { error } = await supabase.rpc('inventory_bulk_item_action', {
        p_shelf_id:shelf.id, p_action:bulkAction.type,
        p_equipment_ids:bulkAction.equipment.map(item => item.id),
        p_consumables:bulkAction.consumables.map(item => ({ item_name:item.name, expected_quantity:item.quantity })),
        p_destination_shelf_id:destination?.id || null, p_reason:reason.trim(),
      })
      if (error) throw error
      const ids = [...bulkAction.equipment.map(item => item.id), ...bulkAction.consumables.flatMap(item => item.units.map(unit => unit.id))]
      const count = bulkAction.equipment.length + bulkAction.consumables.length
      setRemovedIds(previous => [...previous,...ids]); setSelectedKeys([])
      setSuccess(bulkAction.type === 'move' ? `${count} selected item(s) moved to ${destination.code}.` : `${count} selected item(s) permanently deleted from the database.`)
      setBulkAction(null)
      await onChange()
    } catch (failure) {
      setUnitError(failure.code === 'PGRST202'
        ? 'Multiple-item actions need a system update. Please contact an administrator.'
        : failure.message)
    } finally { setSavingUnit(false) }
  }
  async function saveConsumableAction(event) {
    event.preventDefault()
    if (!canManage || busy || !actionConsumable || actionsUnavailable || (consumableAction.type === 'delete' && permanentDeleteRequired)) return
    setUnitError(''); setSuccess('')
    const destination = destinations.find(item => item.id === destinationId)
    if (consumableAction.type === 'move' && !destination) { setUnitError('Choose a destination shelf.'); return }
    if (consumableAction.type === 'delete' && !reason.trim()) { setUnitError('Enter a deletion reason.'); return }
    setSavingUnit(true)
    try {
      const common = { p_shelf_id:shelf.id, p_item_name:actionConsumable.name, p_expected_quantity:actionConsumable.quantity }
      const { error } = consumableAction.type === 'move'
        ? await supabase.rpc('inventory_move_consumable', { ...common, p_destination_shelf_id:destination.id, p_notes:reason.trim() })
        : await supabase.rpc('inventory_delete_consumable', { ...common, p_reason:reason.trim() })
      if (error) throw error
      setRemovedIds(previous => [...previous,...actionConsumable.units.map(item => item.id)])
      setSuccess(consumableAction.type === 'move'
        ? `${actionConsumable.name} moved to ${destination.code} (quantity ${actionConsumable.quantity}).`
        : `${actionConsumable.name} permanently deleted from the database (quantity ${actionConsumable.quantity}).`)
      setConsumableAction(null)
      await onChange()
    } catch (failure) {
      setUnitError(failure.code === 'PGRST202'
        ? 'Consumable actions need a system update. Please contact an administrator.'
        : failure.message)
    } finally { setSavingUnit(false) }
  }
  async function addItems(event) {
    event.preventDefault()
    if (!canManage || busy || migrationRequired || itemNamesRequired || itemCategoriesRequired) return
    const count = Number(quantity)
    setStockError(''); setSuccess('')
    if (!Number.isInteger(count) || count < 1 || count > 1000) { setStockError('Enter a whole-number quantity from 1 to 1000.'); return }
    if (!stockItem.trim()) { setStockError('Enter an item name.'); return }
    setSavingStock(true)
    try {
      const { error } = await supabase.rpc('inventory_receive_categorized_items', { p_shelf_id: shelf.id, p_item_name: stockItem.trim(), p_inventory_kind: inventoryKind, p_quantity: count, p_description: description.trim() })
      if (error) throw error
      setAddingItems(false)
      setSuccess(`${count} ${stockItem.trim()} item(s) added to ${shelf.name}.`)
      await onChange()
    } catch (failure) { setStockError(failure.code === 'PGRST202'
      ? 'Stock tracking needs a system update. Please contact an administrator.'
      : failure.message) }
    finally { setSavingStock(false) }
  }
  async function openReturnAction(item) {
    if (!canOperate) return
    openUnitAction('return', item)
    setReturnLoans([]); setReturnLoanId(''); setReturnCondition('good'); setPhysicalReturn(false); setLoadingReturn(true)
    try {
      const { data, error } = await supabase.from('transactions').select('id,reference,expected_return_at').eq('unit_id', item.id).is('returned_at', null).order('borrowed_at')
      if (error) throw error
      setReturnLoans(data || []); setReturnLoanId(data?.length === 1 ? data[0].id : '')
    } catch (failure) { setUnitError(failure.message); setAction(null) }
    finally { setLoadingReturn(false) }
  }
  async function saveUnitAction(event) {
    event.preventDefault()
    if (busy || !actionUnit || migrationRequired || (action.type !== 'return' && (actionsUnavailable || actionUnit.status === 'borrowed'))) return
    if (action.type === 'delete' && permanentDeleteRequired) return
    setUnitError(''); setSuccess('')
    if (action.type === 'delete' && !reason.trim()) { setUnitError('Enter a reason for deleting this unit.'); return }
    const destination = destinations.find(item => item.id === destinationId)
    if (action.type === 'move' && !destination) { setUnitError('Choose a compatible destination shelf.'); return }
    if (action.type === 'return' && !returnLoans.length && (!physicalReturn || !reason.trim())) { setUnitError('Confirm the equipment is physically back and enter a reason.'); return }
    if (action.type === 'return' && returnLoans.length && !returnLoans.some(loan => loan.id === returnLoanId)) { setUnitError('Choose the loan being returned.'); return }
    setSavingUnit(true)
    try {
      if (action.type === 'return') {
        const { error } = returnLoans.length
          ? await supabase.rpc('inventory_return', { p_transaction_id: returnLoanId, p_condition: returnCondition })
          : await supabase.rpc('inventory_reconcile_return', { p_unit_id: actionUnit.id, p_condition: returnCondition, p_reason: reason.trim() })
        if (error) throw error
        const updated = await supabase.from('inventory_units').select('status,condition').eq('id', actionUnit.id).single()
        if (updated.error) {
          setAction(null); await onChange()
          throw new Error('The return was saved, but the refreshed unit could not be loaded. Refresh the shelf before trying another action.')
        }
        setUnitOverrides(previous => ({ ...previous, [actionUnit.id]: { source: shelf.inventory_units, values: updated.data } }))
        setSuccess(updated.data.status === 'borrowed' ? 'Return recorded. This unit still has another active loan.' : `${unitName(actionUnit)} returned. ${updated.data.status === 'available' ? 'It is available to move or delete.' : 'Damaged equipment is under maintenance.'}`)
        setAction(null); setUnitId(null); await onChange()
        return
      }
      const { error } = action.type === 'delete'
        ? await supabase.rpc('inventory_delete_unit', { p_unit_id: actionUnit.id, p_reason: reason.trim() })
        : await supabase.rpc('inventory_move_unit', { p_unit_id: actionUnit.id, p_destination_shelf_id: destination.id, p_notes: reason.trim() })
      if (error) throw error
      setRemovedIds(previous => [...previous, actionUnit.id])
      setSuccess(action.type === 'delete' ? `${unitName(actionUnit)} permanently deleted from the database.` : `${unitName(actionUnit)} moved to ${destination.code}. Its QR code stays the same.`)
      setAction(null); setUnitId(null)
      await onChange()
    } catch (failure) {
      setUnitError(failure.code === 'PGRST202' && action.type === 'return'
        ? 'Return status correction needs a system update. Please contact an administrator.'
        : failure.message)
    }
    finally { setSavingUnit(false) }
  }
  async function deleteShelf() {
    if (!canManage || busy || addingItems || hasStock || migrationRequired || permanentDeleteRequired) return
    if (!window.confirm(`Permanently delete shelf "${shelf.name}" (${shelf.code}) from the database? This cannot be undone. Historical transaction records will remain.`)) return
    setDeleting(true); setDeleteError('')
    try {
      const { error } = await supabase.rpc('inventory_delete_shelf', { p_id: shelf.id })
      if (error) throw error
      await onChange()
      close()
    } catch (failure) { setDeleteError(failure.message) }
    finally { setDeleting(false) }
  }
  return <div className="backdrop inventory-qr-backdrop" onClick={requestClose}><div className={'modal qr-modal inventory-qr-modal' + (!addingItems && !unit ? ' shelf-inventory-modal' : '')} role="dialog" aria-modal="true" aria-label="Inventory QR labels" onClick={event => event.stopPropagation()}>
    <button className="x" onClick={requestClose} disabled={busy} aria-label="Close QR labels">×</button>
    <div className="inventory-qr-body" ref={body}>
    {unitError && <div role="alert" className="connection-error">{unitError}</div>}
    {success && <div role="status" className="success-message">{success}</div>}
    {stockError && <div role="alert" className="connection-error">{stockError}</div>}
    {canManage && addingItems && <form className="unit-action-form" aria-label="Add items" onSubmit={addItems}>
      <h3>Add items to {shelf.name}</h3>
      <label>Item name<input required maxLength={120} autoFocus disabled={busy} list="shelf-item-names" value={stockItem} onChange={event => setStockItem(event.target.value)}/><datalist id="shelf-item-names">{shelfItems(shelf).filter(item => item.kind === inventoryKind).map(item => <option key={item.key} value={item.name}/>)}</datalist></label>
      <label>Inventory category<select aria-label="Inventory category" required disabled={busy} value={inventoryKind} onChange={event => setInventoryKind(event.target.value)}><option value="equipment">Equipment · QR per unit</option><option value="consumable">Consumables · QR per item</option></select></label>
      <label>Quantity<input type="number" required min="1" max="1000" step="1" disabled={busy} value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
      <label>Description (optional)<textarea aria-label="Description (optional)" maxLength={1000} disabled={busy} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <div className="unit-action-buttons"><button className="primary" disabled={busy}>{savingStock ? 'Adding…' : 'Confirm add'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setAddingItems(false); setStockError('') }}>Cancel</button></div>
    </form>}
    {(!canManage || !addingItems) && (unit ? <><button className="secondary" onClick={() => setUnitId(null)}>All items</button><QRLabel shelf={shelf} unit={unit}/>
    </> : <>
      <h2>{shelf.name} · items</h2>
      {shelf.description && <p className="item-description">{shelf.description}</p>}
      {canManage && actionsUnavailable && <p className="unit-setup-help">Complete the unit management database setup shown on the main page to enable Move and Delete.</p>}
      {canManage && !!selectableKeys.length && <div className="inventory-selection-toolbar" role="group" aria-label="Item selection">
        <button type="button" className="secondary" disabled={selectionDisabled || selectedCount === selectableKeys.length} onClick={() => setSelectedKeys(selectableKeys)}>Select all items</button>
        <span role="status">{selectedCount} selected</span>
        {!!selectedCount && <button type="button" className="secondary" disabled={selectionDisabled} onClick={() => setSelectedKeys([])}>Clear selection</button>}
        <button type="button" className="secondary" disabled={busy || actionsUnavailable || !selectedCount || !!bulkAction || !destinations.length} onClick={() => openBulkAction('move')}>Move selected</button>
        <button type="button" className="delete-unit-button" disabled={busy || actionsUnavailable || permanentDeleteRequired || !selectedCount || !!bulkAction} onClick={() => openBulkAction('delete')}>Delete selected</button>
      </div>}
      {canManage && equipmentUnits.some(item => item.status === 'borrowed') && <p className="inventory-selection-help">Return borrowed equipment before selecting it.</p>}
      {canManage && bulkAction && <form className="unit-action-form" aria-label={`${bulkAction.type === 'move' ? 'Move' : 'Delete'} selected items`} onSubmit={saveBulkAction}>
        <h3>{bulkAction.type === 'move' ? 'Move' : 'Delete'} {bulkAction.equipment.length + bulkAction.consumables.length} selected item(s)</h3>
        <ul className="bulk-item-summary">
          {bulkAction.equipment.map(item => <li key={item.id}>{unitName(item)} · {itemName(item,shelf)}</li>)}
          {bulkAction.consumables.map(item => <li key={item.key}>{itemLabel(item.units[0],shelf)} · {item.name} · quantity {item.quantity}</li>)}
        </ul>
        {bulkAction.type === 'move' ? <>
          <p>Move all selected equipment and the full quantity of each selected consumable. Matching consumable stock will be combined at the destination.</p>
          <label>Destination shelf<select aria-label="Destination shelf" required disabled={busy} value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Choose a shelf</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
        </> : <p>Permanently delete these items and their remaining quantities from the database. This cannot be undone. Historical movement records remain.</p>}
        <label>{bulkAction.type === 'delete' ? 'Deletion reason' : 'Move notes (optional)'}<textarea aria-label={bulkAction.type === 'delete' ? 'Deletion reason' : 'Move notes (optional)'} required={bulkAction.type === 'delete'} maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)}/></label>
        <div className="unit-action-buttons"><button className={bulkAction.type === 'delete' ? 'delete-unit-button' : 'primary'} disabled={busy || (bulkAction.type === 'move' && !destinations.length)}>{savingUnit ? 'Saving…' : bulkAction.type === 'delete' ? 'Confirm delete selected' : 'Confirm move selected'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setBulkAction(null); setUnitError('') }}>Cancel</button></div>
      </form>}
      {actionConsumable && <form className="unit-action-form" aria-label={`${consumableAction.type === 'move' ? 'Move' : 'Delete'} consumable`} onSubmit={saveConsumableAction}>
        <h3>{consumableAction.type === 'move' ? 'Move' : 'Delete'} {itemLabel(actionConsumable.units[0],shelf)} · {actionConsumable.name}</h3>
        {consumableAction.type === 'move' ? <>
          <p>Move this item and its full quantity of {actionConsumable.quantity}. Matching consumable stock at the destination will be combined.</p>
          <label>Destination shelf<select aria-label="Destination shelf" required disabled={busy} value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Choose a shelf</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
          {!destinations.length && <p>Add another shelf before moving this item.</p>}
        </> : <p>Permanently delete this consumable and its remaining quantity of {actionConsumable.quantity} from the database. This cannot be undone. Historical movement records remain.</p>}
        <label>{consumableAction.type === 'delete' ? 'Deletion reason' : 'Move notes (optional)'}<textarea aria-label={consumableAction.type === 'delete' ? 'Deletion reason' : 'Move notes (optional)'} required={consumableAction.type === 'delete'} maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)}/></label>
        <div className="unit-action-buttons"><button className={consumableAction.type === 'delete' ? 'delete-unit-button' : 'primary'} disabled={busy || (consumableAction.type === 'move' && !destinations.length)}>{savingUnit ? 'Saving…' : consumableAction.type === 'delete' ? 'Confirm delete' : 'Confirm move'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setConsumableAction(null); setUnitError('') }}>Cancel</button></div>
      </form>}
      {actionUnit && <form className="unit-action-form" onSubmit={saveUnitAction}>
        <h3>{action.type === 'move' ? 'Move' : action.type === 'return' ? 'Return' : 'Delete'} {unitName(actionUnit)}</h3>
        {action.type === 'return' ? loadingReturn ? <p role="status">Checking active loans…</p> : <>
          {returnLoans.length ? <label>Active loan<select required disabled={busy} value={returnLoanId} onChange={event => setReturnLoanId(event.target.value)}><option value="">Choose a loan</option>{returnLoans.map(loan => <option key={loan.id} value={loan.id}>{loan.reference} · due {loan.expected_return_at}</option>)}</select></label>
            : <p>This unit is marked borrowed, but has no active loan record. Confirm its physical return to correct its status. Existing transaction history will stay unchanged.</p>}
          <label>Return condition<select disabled={busy} value={returnCondition} onChange={event => setReturnCondition(event.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label>
          {!returnLoans.length && <label className="unit-return-confirmation"><input type="checkbox" required disabled={busy} checked={physicalReturn} onChange={event => setPhysicalReturn(event.target.checked)}/>I confirm this unit is physically back in the laboratory</label>}
        </> : action.type === 'move' ? <><label>Destination shelf<select aria-label="Destination shelf" required disabled={busy} value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Choose a shelf</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
          <p>{destinations.length ? 'The unit keeps its item name, category, permanent ID, and QR code. Its display number may change on the new shelf.' : 'Add another shelf before moving this unit.'}</p></> : <p>This permanently deletes the equipment unit’s database row. This cannot be undone. Historical transaction records will remain.</p>}
        {!(action.type === 'return' && (loadingReturn || returnLoans.length)) && <label>{action.type === 'delete' ? 'Deletion reason' : action.type === 'return' ? 'Return confirmation reason' : 'Move notes (optional)'}<textarea required={action.type !== 'move'} maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)}/></label>}
        <div className="unit-action-buttons"><button className={action.type === 'delete' ? 'delete-unit-button' : 'primary'} disabled={busy || (action.type === 'move' && !destinations.length) || (action.type === 'delete' && permanentDeleteRequired)}>{savingUnit ? 'Saving…' : action.type === 'delete' ? 'Confirm delete' : action.type === 'return' ? 'Confirm return' : 'Confirm move'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setAction(null); setUnitError('') }}>Cancel</button></div>
      </form>}
      <div className="shelf-inventory-columns"><section className="shelf-equipment-column" aria-label="Equipment"><h3>Equipment</h3>
      {!equipmentUnits.length && <p className="inventory-column-empty">No equipment.</p>}
      <div className="equipment-label-list">{equipmentUnits.map(item => <div key={item.id} className={selectedKeys.includes(`equipment:${item.id}`) ? 'inventory-item-selected' : ''}><span><label className="inventory-item-select">{canManage && <input type="checkbox" aria-label={`Select ${unitName(item)} · ${itemName(item,shelf)}`} disabled={selectionDisabled || item.status === 'borrowed'} checked={item.status !== 'borrowed' && selectedKeys.includes(`equipment:${item.id}`)} onChange={() => toggleSelection(`equipment:${item.id}`)}/>}<b>{unitName(item)}</b></label><small className="equipment-item-name">{itemName(item, shelf)}</small>{item.description && <small className="item-description">{item.description}</small>}<small>{item.status.replaceAll('_', ' ')} · {item.condition}</small>{item.status === 'borrowed' && <small>Return this equipment before moving or deleting it.</small>}</span>
        <div className="unit-action-buttons"><button type="button" className="secondary" disabled={busy} onClick={() => { setUnitId(item.id); setAction(null); setConsumableAction(null) }}>View QR</button>{canOperate && item.status === 'borrowed' && <button type="button" className="secondary" aria-label={`Return ${unitName(item)}`} disabled={busy || migrationRequired} onClick={() => openReturnAction(item)}>Return</button>}{canManage && <button type="button" className="secondary" aria-label={`Move ${unitName(item)}`} disabled={busy || actionsUnavailable || item.status === 'borrowed'} onClick={() => openUnitAction('move', item)}>Move</button>}{canManage && <button type="button" className="delete-unit-button" aria-label={`Delete ${unitName(item)}`} disabled={busy || actionsUnavailable || permanentDeleteRequired || item.status === 'borrowed'} onClick={() => openUnitAction('delete', item)}>Delete</button>}</div>
      </div>)}</div></section>
      <section className="shelf-consumable-column" aria-label="Consumables"><h3>Consumables</h3>
      {!consumableItems.length && <p className="inventory-column-empty">No consumables.</p>}
      <div className="consumable-item-list">{consumableItems.map((item,index) => <article className={'consumable-item-card' + (selectedKeys.includes(item.key) ? ' inventory-item-selected' : '')} key={item.key}><div className="consumable-item-details">
        <label className="inventory-item-select">{canManage && <input type="checkbox" aria-label={`Select ${itemLabel(item.units[0],shelf)} · ${item.name}`} disabled={selectionDisabled || !selectableConsumables.includes(item)} checked={selectableConsumables.includes(item) && selectedKeys.includes(item.key)} onChange={() => toggleSelection(item.key)}/>}<b>{item.units[0].consumable_number ? itemLabel(item.units[0],shelf) : `Consumable ${String(index+1).padStart(3,'0')}`}</b></label>
        <strong>{item.name}</strong>
        {item.units[0].description && <small className="item-description">{item.units[0].description}</small>}
        <span className="consumable-quantity">Quantity: <b>{item.quantity}</b></span>
        {item.available !== item.quantity && <small>{item.available} available</small>}
        </div><div className="unit-action-buttons">
          <button type="button" className="secondary" aria-label={`View QR for ${itemLabel(item.units[0],shelf)}`} disabled={busy} onClick={() => { setUnitId(item.units[0].id); setAction(null); setConsumableAction(null) }}>View QR</button>
          {canManage && <button type="button" className="secondary" aria-label={`Move ${itemLabel(item.units[0],shelf)}`} disabled={busy || actionsUnavailable} onClick={() => openConsumableAction('move',item)}>Move</button>}
          {canManage && <button type="button" className="delete-unit-button" aria-label={`Delete ${itemLabel(item.units[0],shelf)}`} disabled={busy || actionsUnavailable || permanentDeleteRequired} onClick={() => openConsumableAction('delete',item)}>Delete</button>}
        </div>
      </article>)}</div>
      </section></div>
    </>)}
    </div>
    {canManage && !addingItems && <div className="inventory-qr-actions">
      {deleteError && <div role="alert" className="connection-error">{deleteError}</div>}
      {deleteShelfHelp && <p id="delete-shelf-help">{deleteShelfHelp}</p>}
      <div className="inventory-qr-action-buttons">
        <button type="button" className="primary" disabled={busy || addingItems || migrationRequired || itemNamesRequired || itemCategoriesRequired} onClick={openAddItems}>Add items</button>
        <button type="button" className="delete-shelf-button" disabled={busy || addingItems || hasStock || migrationRequired || permanentDeleteRequired} aria-describedby={deleteShelfHelp ? 'delete-shelf-help' : undefined} onClick={deleteShelf}>{deleting ? 'Deleting…' : 'Delete shelf'}</button>
      </div>
    </div>}
  </div></div>
}

export function InventoryScanner({ onChange, migrationRequired, itemNamesRequired = false, itemCategoriesRequired = false, laboratoryId }) {
  const [value, setValue] = useState(''), [result, setResult] = useState(null)
  const [error, setError] = useState(''), [done, setDone] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [scanning, setScanning] = useState(false)
  const [borrowers, setBorrowers] = useState([]), [borrowerId, setBorrowerId] = useState('')
  const [borrowerName, setBorrowerName] = useState(''), [identity, setIdentity] = useState('')
  const [due, setDue] = useState(defaultReturnDate)
  const [quantity, setQuantity] = useState(1), [notes, setNotes] = useState('')
  const [issueItem, setIssueItem] = useState('')
  const [loan, setLoan] = useState(null), [condition, setCondition] = useState('good')
  const video = useRef(null), stream = useRef(null), lookupVersion = useRef(0), cameraVersion = useRef(0)
  useEffect(() => () => {
    lookupVersion.current++; cameraVersion.current++
    stream.current?.getTracks().forEach(track => track.stop())
  }, [])
  function stopCamera() {
    cameraVersion.current++
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null
    if (video.current) video.current.srcObject = null
    setScanning(false)
  }
  async function lookup(code = value) {
    if (busy) return
    stopCamera()
    const version = ++lookupVersion.current
    setLoading(true); setResult(null); setLoan(null); setError(''); setDone('')
    setBorrowerId(''); setBorrowerName(''); setIdentity(''); setQuantity(1); setNotes(''); setCondition('good'); setIssueItem('')
    try {
      const response = await fetchInventoryByQR(code)
      if (version !== lookupVersion.current) return
      if (response.error) throw response.error
      const data = response.data
      if (laboratoryId && data.laboratory_id !== laboratoryId) throw new Error('This item belongs to another laboratory. Choose its laboratory before scanning it.')
      if (data.qr_kind === 'consumable') {
        const items = shelfItems(data)
        if (data.qr_item_name || items.length === 1) setIssueItem(items[0].name)
      }
      if (data.qr_kind === 'equipment') {
        const unit = data.inventory_units[0]
        if (unit.status === 'borrowed') {
          const response = await supabase.from('transactions').select('id,borrowers(name)').eq('unit_id', unit.id).is('returned_at', null).order('borrowed_at').order('id').limit(1).maybeSingle()
          if (version !== lookupVersion.current) return
          if (response.error) throw response.error
          if (!response.data) throw new Error('This unit is marked borrowed but has no active loan. Open its shelf and use Return to confirm its physical return and correct the status.')
          setLoan(response.data)
        } else if (availableUnits(data).length) {
          const response = await fetchBorrowers()
          if (version !== lookupVersion.current) return
          if (response.error) throw response.error
          setBorrowers(response.data || [])
        }
      }
      setResult(data)
    } catch (failure) { if (version === lookupVersion.current) setError(failure.message) }
    finally { if (version === lookupVersion.current) setLoading(false) }
  }
  async function startCamera() {
    setError(''); setDone('')
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera scanning is unavailable in this browser. Enter the QR value manually.'); return
    }
    stopCamera()
    const version = cameraVersion.current
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (version !== cameraVersion.current) { camera.getTracks().forEach(track => track.stop()); return }
      stream.current = camera; video.current.srcObject = camera
      await video.current.play()
      if (version !== cameraVersion.current) return
      setScanning(true)
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      async function detect() {
        if (version !== cameraVersion.current || !video.current) return
        const codes = await detector.detect(video.current).catch(() => [])
        if (version !== cameraVersion.current) return
        if (codes[0]?.rawValue) { setValue(codes[0].rawValue); lookup(codes[0].rawValue) }
        else requestAnimationFrame(detect)
      }
      detect()
    } catch (failure) { if (version === cameraVersion.current) { stopCamera(); setError(failure.message || 'Camera permission was denied.') } }
  }
  async function transact(event) {
    event.preventDefault()
    if (busy || !result || migrationRequired) return
    stopCamera(); setBusy(true); setError(''); setDone('')
    try {
      let success
      if (result.qr_kind === 'consumable') {
        if (itemNamesRequired || itemCategoriesRequired) throw new Error('Complete the item database update shown on the main page before issuing supplies.')
        if (!issueItem) throw new Error('Choose an item to issue.')
        const count = Number(quantity)
        if (!Number.isInteger(count) || count < 1 || count > Math.min(1000, available)) throw new Error('Enter an available whole-number quantity from 1 to 1000.')
        if (!notes.trim()) throw new Error('Enter the issue reason or recipient.')
        const { error } = await supabase.rpc('inventory_item_category_stock_move', { p_shelf_id: result.id, p_direction: 'out', p_item_name: issueItem, p_inventory_kind: 'consumable', p_quantity: count, p_notes: notes.trim() })
        if (error) throw error
        success = `${count} ${issueItem} unit(s) issued.`
      } else if (loan) {
        const { error } = await supabase.rpc('inventory_return', { p_transaction_id: loan.id, p_condition: condition })
        if (error) throw error
        success = 'Equipment return recorded.'
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < localDateValue()) throw new Error('Return date must be today or later.')
        const unit = availableUnits(result)[0]
        if (!unit) throw new Error('This equipment unit is not available for borrowing.')
        let borrower = borrowers.find(item => item.id === borrowerId)
        if (!borrower) {
          if (!borrowerName.trim() || !identity.trim()) throw new Error('Select a borrower or enter a name and ID.')
          const response = await supabase.from('borrowers').insert({ name: borrowerName.trim(), identity_number: identity.trim() }).select().single()
          if (response.error) throw response.error
          borrower = response.data
          setBorrowers(previous => [...previous, borrower]); setBorrowerId(borrower.id)
        }
        const { error } = await supabase.rpc('inventory_checkout', { p_unit_id: unit.id, p_borrower_id: borrower.id, p_expected_return: due })
        if (error) throw error
        success = 'Equipment checked out successfully.'
      }
      // A transaction can succeed even if the subsequent inventory refresh fails.
      setResult(null); setLoan(null); setDone(success)
      await onChange()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  const unit = result?.qr_kind === 'equipment' ? result.inventory_units[0] : null
  const items = result ? shelfItems(result) : []
  const available = result?.qr_kind === 'consumable' ? items.find(item => item.name === issueItem)?.available || 0 : result ? availableUnits(result).length : 0
  return <section className="card page inventory-scanner">
    <div className="cardhead"><div><h2>Scan inventory QR</h2><p>Scan an equipment unit or a consumable item label.</p></div></div>
    {migrationRequired ? <p>Complete the database setup shown above to use equipment and consumable QR scanning.</p> : <>
      <div className="scanner-grid"><div className="scanner-camera"><video ref={video} muted playsInline/>{!scanning && <div className="camera-placeholder">▣<span>Camera preview</span></div>}</div>
        <div className="scanner-controls"><button className="primary" disabled={busy || loading} onClick={scanning ? stopCamera : startCamera}>{scanning ? 'Stop camera' : 'Open camera'}</button>
          <form className="scan-input" onSubmit={event => { event.preventDefault(); lookup() }}><input aria-label="QR value" value={value} disabled={busy || loading} onChange={event => setValue(event.target.value)} placeholder="Equipment or consumable QR"/><button disabled={busy || loading}>{loading ? 'Searching…' : 'Search'}</button></form>
          <small>Allow camera access when prompted, or paste the value printed with a QR label.</small></div></div>
      {error && <div role="alert" className="connection-error">{error}</div>}
      {done && <div role="status" className="success-message">{done}</div>}
      {result && <div className="inventory-qr-result"><div><span className="eyebrow">{unit ? 'EQUIPMENT FOUND' : result.qr_item_name ? 'CONSUMABLE FOUND' : 'CONSUMABLE SHELF FOUND'}</span><h2>{unit ? `${itemName(unit, result)} · ${unitName(unit)}` : result.qr_item_name || result.name}</h2><p>{result.code}</p>
        {unit ? <><code className="qr-value">Permanent ID: {unit.id}</code><p>Status: {unit.status.replaceAll('_', ' ')} · Condition: {unit.condition}</p>{unit.description && <p className="item-description">{unit.description}</p>}{unit.comment && <p>{unit.comment}</p>}</> : <div className="shelf-item-summary">{items.map(item => <div key={item.name}><b>{item.name}</b><span>{item.available} available</span></div>)}</div>}</div>
        <form className="checkout-form" onSubmit={transact}>
          {!unit ? <><h3>Issue consumables</h3>{result.qr_item_name ? <p>Item: <b>{issueItem}</b></p> : <label>Item<select aria-label="Item" required disabled={busy || itemNamesRequired || itemCategoriesRequired} value={issueItem} onChange={event => { setIssueItem(event.target.value); setQuantity(1) }}><option value="">Choose an item</option>{items.map(item => <option key={item.key} value={item.name} disabled={!item.available}>{item.name} · {item.available} available</option>)}</select></label>}<label>Quantity<input required type="number" min="1" max={Math.min(1000, available)} step="1" disabled={busy} value={quantity} onChange={event => setQuantity(event.target.value)}/></label><label>Issue reason / recipient<textarea required maxLength={1000} disabled={busy} value={notes} onChange={event => setNotes(event.target.value)}/></label></> : loan ? <><h3>Return this equipment</h3><p>Borrower: {loan.borrowers?.name || 'See transaction history'}</p><label>Return condition<select value={condition} disabled={busy} onChange={event => setCondition(event.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label></> : available ? <>
            <h3>Borrow this equipment</h3><label>Borrower<select disabled={busy} value={borrowerId} onChange={event => setBorrowerId(event.target.value)}><option value="">Choose a borrower or enter a new one</option>{borrowers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.identity_number}</option>)}</select></label>
            <div className="new-borrower"><label>New borrower name<input disabled={busy} value={borrowerName} onChange={event => { setBorrowerName(event.target.value); setBorrowerId('') }}/></label><label>Student / employee ID<input disabled={busy} value={identity} onChange={event => { setIdentity(event.target.value); setBorrowerId('') }}/></label></div><label>Expected return date<input required type="date" min={localDateValue()} disabled={busy} value={due} onChange={event => setDue(event.target.value)}/></label>
          </> : <p>This unit is unavailable for borrowing. Review its status and condition in Items.</p>}
          <button className="primary" disabled={busy || (!unit && (itemNamesRequired || itemCategoriesRequired)) || (!loan && !available)}>{busy ? 'Saving…' : !unit ? 'Confirm issue' : loan ? 'Confirm return' : 'Confirm checkout'}</button>
        </form></div>}
    </>}
  </section>
}

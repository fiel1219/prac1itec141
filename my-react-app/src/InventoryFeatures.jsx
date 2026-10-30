import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { activeUnits, recordQuantity, itemLabel, itemName, shelfItems, inventorySummary, downloadCsv } from './lib/inventory'
import { isConsumableUnit } from './lib/inventoryQR'
import './InventoryFeatures.css'

function Message({ error, success }) {
  return <>{error && <div role="alert" className="connection-error">{error}</div>}{success && <div role="status" className="success-message">{success}</div>}</>
}

const emptyShelf = { code: '', name: '', description: '' }

async function saveShelf(id, form, laboratoryId) {
  const args = { p_id: id, p_code: form.code, p_name: form.name, p_description: (form.description || '').trim() }
  const response = laboratoryId
    ? await supabase.rpc('inventory_save_laboratory_shelf',{ ...args,p_laboratory_id:laboratoryId })
    : await supabase.rpc('inventory_save_shelf_details',args)
  if (response.error?.code === 'PGRST202') return { ...response, error: { ...response.error,
    message: 'Shelf descriptions need a system update. Please contact an administrator.' } }
  return response
}

function ShelfForm({ form, setForm, onSubmit, onCancel, busy, title }) {
  return <form className="inventory-form shelf-details-form" onSubmit={onSubmit} aria-label={title || 'Add shelf'}>
    {title && <h3>{title}</h3>}
    {[['code','Shelf code'],['name','Shelf name']].map(([key,label]) => <label key={key}>{label}<input required maxLength={120} disabled={busy} autoFocus={key === 'code'} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
    <label>Description (optional)<textarea aria-label="Description (optional)" maxLength={1000} disabled={busy} value={form.description || ''} onChange={event => setForm({ ...form, description: event.target.value })}/></label>
    <div className="inventory-buttons"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save shelf'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>
}

export function AddShelfDialog({ onClose, onSaved, laboratoryId }) {
  const [form, setForm] = useState(emptyShelf), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [busy,onClose])
  function close() { if (!busy) onClose() }
  async function save(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const { data, error: failure } = await saveShelf(null, form, laboratoryId)
      if (failure) throw failure
      await onSaved(data)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <div className="backdrop shelf-form-backdrop" onClick={close}><div className="modal inventory-feature shelf-form-modal" role="dialog" aria-modal="true" aria-labelledby="add-shelf-title" onClick={event => event.stopPropagation()}>
    <button className="x" type="button" onClick={close} disabled={busy} aria-label="Close add shelf">×</button>
    <h2 id="add-shelf-title">Add shelf</h2>
    <Message error={error}/>
    <ShelfForm form={form} setForm={setForm} onSubmit={save} onCancel={close} busy={busy}/>
  </div></div>
}

export function ItemManagement({ shelves, onChange, onUnitQR }) {
  const [query,setQuery] = useState('')
  const [unit,setUnit] = useState(null), [editing,setEditing] = useState(null)
  const [error,setError] = useState(''), [success,setSuccess] = useState(''), [busy,setBusy] = useState(false)
  const editForm = useRef(null)
  const search = query.trim().toLowerCase()
  const allEquipment = shelves.flatMap(shelf => activeUnits(shelf).filter(item => !isConsumableUnit(item,shelf)).map(item => ({ shelf,item })))
    .sort((a,b) => itemName(a.item,a.shelf).localeCompare(itemName(b.item,b.shelf)) || a.item.unit_number-b.item.unit_number || a.item.id.localeCompare(b.item.id))
  const allConsumables = shelves.flatMap(shelf => shelfItems(shelf).filter(item => item.kind === 'consumable').map(item => ({ shelf,item })))
    .sort((a,b) => a.item.name.localeCompare(b.item.name) || a.shelf.id.localeCompare(b.shelf.id))
  const matches = values => values.some(value => String(value || '').toLowerCase().includes(search))
  const equipment = allEquipment.filter(({shelf,item}) => matches([itemLabel(item,shelf),itemName(item,shelf),item.description]))
  const consumables = allConsumables.filter(({shelf,item}) => matches([itemLabel(item.units[0],shelf),item.name,...item.units.map(stock => stock.description)]))
  const editingShelf = shelves.find(shelf => shelf.id === editing?.shelfId)
  const editingGroup = editing?.groupKey && editingShelf ? shelfItems(editingShelf).find(item => item.key === editing.groupKey) : null
  function edit(shelf,item,groupKey) {
    if (busy || item.status === 'borrowed') return
    setEditing({ shelfId:shelf.id,groupKey });setUnit({ ...item });setError('');setSuccess('')
    requestAnimationFrame(() => editForm.current?.scrollIntoView({ block:'nearest' }))
  }
  async function save(event) {
    event.preventDefault()
    if (busy || !unit) return
    setBusy(true);setError('');setSuccess('')
    try {
      const { error:failure } = await supabase.rpc('inventory_update_unit',{ p_id:unit.id,p_status:unit.status,p_condition:unit.condition,p_comment:unit.comment || '' })
      if (failure) throw failure
      setUnit(null);setEditing(null);setSuccess('Item updated.')
      await onChange()
    } catch (failure) {
      setError(failure.code === '23505' ? 'This consumable already has stock with that status and condition. Choose a different combination.' : failure.message)
    } finally { setBusy(false) }
  }
  return <section className="card page inventory-feature item-management">
    <div className="cardhead"><div><h2>Equipment and Consumables</h2><p>{allEquipment.length} equipment · {allConsumables.length} consumable items</p></div></div>
    <Message error={error} success={success}/>
    <label className="inventory-search">Search items<input aria-label="Search items" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, reference, or description"/></label>
    {unit && editingShelf && <form ref={editForm} className="inventory-form" aria-label="Edit item" onSubmit={save}>
      <h3>Edit {itemLabel(unit,editingShelf)} · {itemName(unit,editingShelf)}</h3>
      {editingGroup?.units.length>1 && <label>Stock record<select aria-label="Stock record" disabled={busy} value={unit.id} onChange={event => setUnit({ ...editingGroup.units.find(item => item.id === event.target.value) })}>{editingGroup.units.map(item => <option key={item.id} value={item.id} disabled={item.status === 'borrowed'}>{recordQuantity(item,editingShelf)} · {item.status.replaceAll('_',' ')} · {item.condition}</option>)}</select></label>}
      <label>Status<select aria-label="Status" disabled={busy} value={unit.status} onChange={event => setUnit({ ...unit,status:event.target.value })}>{['available','under_maintenance','missing','not_found'].map(status => <option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select></label>
      <label>Condition<select aria-label="Condition" disabled={busy} value={unit.condition} onChange={event => setUnit({ ...unit,condition:event.target.value })}><option value="good">Good</option><option value="damaged">Damaged</option></select></label>
      <label>Comment<textarea aria-label="Comment" maxLength={1000} disabled={busy} value={unit.comment || ''} onChange={event => setUnit({ ...unit,comment:event.target.value })}/></label>
      <div className="inventory-buttons"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save item'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setUnit(null);setEditing(null);setError('') }}>Cancel</button></div>
    </form>}
    <section className="item-list-section" aria-label="Equipment"><h3>Equipment <span>{equipment.length}</span></h3>
      {!!equipment.length && <div className="inventory-table"><table><thead><tr><th>Reference</th><th>Item name</th><th>Description</th><th>Status</th><th>Condition</th><th>Actions</th></tr></thead><tbody>{equipment.map(({shelf,item}) => <tr key={item.id}>
        <td>{itemLabel(item,shelf)}</td><td><b>{itemName(item,shelf)}</b></td><td className="item-description">{item.description || '—'}</td><td>{item.status.replaceAll('_',' ')}</td><td>{item.condition}</td>
        <td><div className="inventory-buttons"><button type="button" className="secondary" disabled={busy || item.status === 'borrowed'} title={item.status === 'borrowed' ? 'Return this equipment before editing it' : undefined} onClick={() => edit(shelf,item)}>Edit item</button><button type="button" className="secondary" disabled={busy} onClick={() => onUnitQR(shelf,item)}>View QR</button></div></td>
      </tr>)}</tbody></table></div>}
      {!equipment.length && <p className="item-list-empty">{search ? 'No equipment matches your search.' : 'No equipment yet.'}</p>}
    </section>
    <section className="item-list-section" aria-label="Consumables"><h3>Consumables <span>{consumables.length}</span></h3>
      {!!consumables.length && <div className="inventory-table"><table><thead><tr><th>Reference</th><th>Item name</th><th>Description</th><th>Quantity</th><th>Available</th><th>Actions</th></tr></thead><tbody>{consumables.map(({shelf,item}) => <tr key={shelf.id+':'+item.key}>
        <td>{itemLabel(item.units[0],shelf)}</td><td><b>{item.name}</b></td><td className="item-description">{[...new Set(item.units.map(stock => stock.description).filter(Boolean))].join('\n') || '—'}</td><td>{item.quantity}</td><td>{item.available}</td>
        <td><div className="inventory-buttons"><button type="button" className="secondary" disabled={busy || item.units.every(stock => stock.status === 'borrowed')} onClick={() => edit(shelf,item.units.find(stock => stock.status !== 'borrowed'),item.key)}>Edit item</button><button type="button" className="secondary" disabled={busy} onClick={() => onUnitQR(shelf,item.units[0])}>View QR</button></div></td>
      </tr>)}</tbody></table></div>}
      {!consumables.length && <p className="item-list-empty">{search ? 'No consumables match your search.' : 'No consumables yet.'}</p>}
    </section>
  </section>
}

export function Reports({ shelves }) {
  const [query, setQuery] = useState(''), [onlyLow, setOnlyLow] = useState(false)
  const summary = inventorySummary(shelves).filter(row => `${row.code} ${row.name} ${row.item_type}`.toLowerCase().includes(query.toLowerCase()) && (!onlyLow || row.low_stock === 'Yes'))
  const fields = ['code','name','item_type','category','total','available','borrowed','damaged','maintenance','missing','threshold','low_stock']
  const headers = ['Code','Name','Item type','Category','Total','Available','Borrowed','Damaged','Maintenance','Missing / not found','Threshold','Low stock']
  return <section className="card inventory-feature"><div className="cardhead"><div><h2>Inventory summary</h2><p>Current active inventory. Damaged and maintenance counts may overlap.</p></div><button className="primary" onClick={() => downloadCsv('inventoscan-inventory.csv',headers,summary.map(row => fields.map(field => row[field])))}>Export summary CSV</button></div><div className="inventory-filters"><label>Search<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Shelf or item type"/></label><label className="inventory-checkbox"><input type="checkbox" checked={onlyLow} onChange={event => setOnlyLow(event.target.checked)}/>Low stock only</label></div><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{summary.map(row => <tr key={`${row.code}:${row.inventory_kind}:${row.item_type}`}>{fields.map(field => <td key={field}>{row[field]}</td>)}</tr>)}</tbody></table></div>{!summary.length && <p className="empty">No inventory matches these filters.</p>}</section>
}

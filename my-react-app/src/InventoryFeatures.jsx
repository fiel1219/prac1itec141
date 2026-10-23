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

export function ItemManagement({ shelves, onChange, onQR, onUnitQR }) {
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
    <div className="cardhead"><div><h2>Items</h2><p>{allEquipment.length} equipment · {allConsumables.length} consumable items</p></div></div>
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
        <td><div className="inventory-buttons"><button type="button" className="secondary" disabled={busy || item.units.every(stock => stock.status === 'borrowed')} onClick={() => edit(shelf,item.units.find(stock => stock.status !== 'borrowed'),item.key)}>Edit item</button><button type="button" className="secondary" disabled={busy} onClick={() => onQR({ ...shelf,qrConsumables:true })}>View QR</button></div></td>
      </tr>)}</tbody></table></div>}
      {!consumables.length && <p className="item-list-empty">{search ? 'No consumables match your search.' : 'No consumables yet.'}</p>}
    </section>
  </section>
}

export function StockMovements({ shelves, onChange, itemNamesRequired = false, itemCategoriesRequired = false, laboratoryId }) {
  const [shelfId, setShelfId] = useState(''), [direction, setDirection] = useState('in'), [quantity, setQuantity] = useState(1), [notes, setNotes] = useState('')
  const [stockItem, setStockItem] = useState('')
  const [stockKind, setStockKind] = useState('equipment')
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const shelf = shelves.find(item => item.id === shelfId)
  const items = shelfItems(shelf || {})
  const selectedItem = items.find(item => item.key === stockItem)
  const available = selectedItem?.available || 0
  async function save(event) {
    event.preventDefault()
    if (busy || itemNamesRequired || itemCategoriesRequired) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const count = Number(quantity)
      const name = direction === 'in' ? stockItem.trim() : selectedItem?.name
      if (!name || !Number.isInteger(count) || count < 1 || count > 1000 || (direction === 'out' && count > available)) throw new Error('Choose an item and enter an available whole-number quantity from 1 to 1000.')
      const { error: failure } = await supabase.rpc('inventory_item_category_stock_move', { p_shelf_id: shelfId, p_direction: direction, p_item_name: name, p_inventory_kind: direction === 'in' ? stockKind : selectedItem.kind, p_quantity: count, p_notes: notes.trim() })
      if (failure) throw failure
      setSuccess(`${quantity} ${name} unit(s) recorded as stock-${direction}.`); setNotes(''); setQuantity(1); setStockItem('')
      setRevision(value => value + 1); await onChange()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <><section className="card inventory-feature"><h2>Record stock movement</h2><p>Receive named items or issue available stock from this shelf.</p><Message error={error} success={success}/><form className="inventory-form" onSubmit={save}>
    <label>Shelf<select aria-label="Shelf" required disabled={busy} value={shelfId} onChange={event => { setShelfId(event.target.value); setStockItem(''); setQuantity(1) }}><option value="">Choose a shelf</option>{shelves.map(item => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label>
    <label>Movement<select aria-label="Movement" disabled={busy} value={direction} onChange={event => { setDirection(event.target.value); setStockItem(''); setQuantity(1) }}><option value="in">Stock-in / receive</option><option value="out">Stock-out / issue or remove</option></select></label>
    {direction === 'in' && <label>Inventory category<select aria-label="Inventory category" disabled={busy} value={stockKind} onChange={event => setStockKind(event.target.value)}><option value="equipment">Equipment · QR per unit</option><option value="consumable">Consumables · shelf QR</option></select></label>}
    {direction === 'in' ? <label>Item name<input required maxLength={120} disabled={busy} list="stock-item-names" value={stockItem} onChange={event => setStockItem(event.target.value)}/><datalist id="stock-item-names">{items.filter(item => item.kind === stockKind).map(item => <option key={item.key} value={item.name}/>)}</datalist></label>
      : <label>Item<select aria-label="Item" required disabled={busy} value={stockItem} onChange={event => { setStockItem(event.target.value); setQuantity(1) }}><option value="">Choose an item</option>{items.map(item => <option key={item.key} value={item.key} disabled={!item.available}>{item.name} · {item.kind === 'consumable' ? 'Consumables' : 'Equipment'} · {item.available} available</option>)}</select></label>}
    <label>Quantity<input type="number" required disabled={busy} min="1" max={direction === 'out' ? Math.min(1000, available) : 1000} step="1" value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
    <label>{direction === 'out' ? 'Removal reason (required)' : 'Receipt notes'}<textarea disabled={busy} required={direction === 'out'} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)}/></label>
    {shelf && direction === 'out' && <p>{available} available units of the selected item.</p>}<button className="primary" disabled={busy || itemNamesRequired || itemCategoriesRequired || !shelf || (direction === 'out' && !available)}>{busy ? 'Saving…' : 'Record movement'}</button>
  </form></section><MovementReport key={revision} laboratoryId={laboratoryId} shelves={shelves} title="Stock movement history"/></>
}

export function Reports({ shelves, laboratoryId }) {
  const [query, setQuery] = useState(''), [onlyLow, setOnlyLow] = useState(false)
  const summary = inventorySummary(shelves).filter(row => `${row.code} ${row.name} ${row.item_type}`.toLowerCase().includes(query.toLowerCase()) && (!onlyLow || row.low_stock === 'Yes'))
  const fields = ['code','name','item_type','category','total','available','borrowed','damaged','maintenance','missing','threshold','low_stock']
  const headers = ['Code','Name','Item type','Category','Total','Available','Borrowed','Damaged','Maintenance','Missing / not found','Threshold','Low stock']
  return <><section className="card inventory-feature"><div className="cardhead"><div><h2>Inventory summary</h2><p>Current active inventory. Damaged and maintenance counts may overlap.</p></div><button className="primary" onClick={() => downloadCsv('inventoscan-inventory.csv',headers,summary.map(row => fields.map(field => row[field])))}>Export summary CSV</button></div><div className="inventory-filters"><label>Search<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Shelf or item type"/></label><label className="inventory-checkbox"><input type="checkbox" checked={onlyLow} onChange={event => setOnlyLow(event.target.checked)}/>Low stock only</label></div><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{summary.map(row => <tr key={`${row.code}:${row.inventory_kind}:${row.item_type}`}>{fields.map(field => <td key={field}>{row[field]}</td>)}</tr>)}</tbody></table></div>{!summary.length && <p className="empty">No inventory matches these filters.</p>}</section><MovementReport laboratoryId={laboratoryId} shelves={shelves}/></>
}

function MovementReport({ shelves, title = 'Stock movement report', laboratoryId }) {
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [shelfId, setShelfId] = useState(''), [direction, setDirection] = useState('all')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(''); setRows([])
      try {
        if (from && to && from > to) throw new Error('Start date must be on or before end date.')
        const records = []
        for (let offset = 0; ; offset += 500) {
          let request = supabase.from('stock_movements').select('*, shelves(code,name), inventory_units(unit_number)').order('created_at', { ascending: false }).order('id').range(offset,offset+499)
          if (laboratoryId) request = request.eq('laboratory_id',laboratoryId)
          if (shelfId) request = request.eq('shelf_id',shelfId)
          if (direction !== 'all') request = request.eq('direction',direction)
          if (from) request = request.gte('created_at',new Date(`${from}T00:00:00`).toISOString())
          if (to) { const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate()+1); request = request.lt('created_at',end.toISOString()) }
          const { data, error: failure } = await request
          if (failure) throw failure
          if (cancelled) return
          records.push(...data)
          if (data.length < 500) break
        }
        if (!cancelled) setRows(records)
      } catch (failure) { if (!cancelled) setError(failure.message) } finally { if (!cancelled) setLoading(false) }
    }
    load(); return () => { cancelled = true }
  }, [from,to,shelfId,direction,reload,laboratoryId])
  const headers = ['Date','Shelf','Item','Category','Unit','Direction','Reason','Quantity','Operator','Notes']
  const values = row => [new Date(row.created_at).toLocaleString(),row.shelf_code || row.shelves?.code || '',row.item_type || '',row.inventory_kind || '',row.unit_number ?? row.inventory_units?.unit_number,row.direction,row.reason,row.quantity,row.actor,row.notes || '']
  return <section className="card inventory-feature"><div className="cardhead"><div><h2>{title}</h2><p>{loading ? 'Loading movements…' : `${rows.length} unit movements`}</p></div><div className="inventory-buttons"><button className="secondary" disabled={loading} onClick={() => setReload(value => value+1)}>Refresh</button><button className="primary" disabled={loading || !!error || !rows.length} onClick={() => downloadCsv('inventoscan-movements.csv',headers,rows.map(values))}>Export movements CSV</button></div></div><div className="inventory-filters"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label>Through<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label><label>Shelf<select value={shelfId} onChange={event => setShelfId(event.target.value)}><option value="">All shelf history</option>{shelves.map(shelf => <option key={shelf.id} value={shelf.id}>{shelf.code}</option>)}</select></label><label>Direction<select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">All</option><option value="in">In</option><option value="out">Out</option><option value="adjustment">Adjustment</option></select></label></div><Message error={error}/>{!loading && !error && <><p className="inventory-totals">Stock-in: {rows.filter(row => row.direction==='in').reduce((sum,row) => sum+Number(row.quantity),0)} · Stock-out: {rows.filter(row => row.direction==='out').reduce((sum,row) => sum+Number(row.quantity),0)} · Adjustments: {rows.filter(row => row.direction==='adjustment').length}</p><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{values(row).map((value,index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>{!rows.length && <p className="empty">No movements match these filters. Recording starts when the inventory migration is applied.</p>}</>}</section>
}

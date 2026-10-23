import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { activeUnits, availableUnits, itemName, shelfItems, inventorySummary, downloadCsv } from './lib/inventory'
import { isConsumableShelf } from './lib/inventoryQR'
import './InventoryFeatures.css'

function Message({ error, success }) {
  return <>{error && <div role="alert" className="connection-error">{error}</div>}{success && <div role="status" className="success-message">{success}</div>}</>
}

const emptyShelf = { code: '', name: '', inventory_kind: 'equipment', low_stock_threshold: 2 }

function saveShelf(id, form) {
  // Retain the legacy database field for older clients; item names belong to units.
  return supabase.rpc('inventory_save_qr_shelf', { p_id: id, p_code: form.code, p_name: form.name, p_item_type: form.item_type || (form.inventory_kind === 'consumable' ? 'Consumables' : 'Equipment'),
    p_threshold: Number(form.low_stock_threshold), p_inventory_kind: form.inventory_kind || 'equipment' })
}

function ShelfForm({ form, setForm, onSubmit, onCancel, busy, title }) {
  return <form className="inventory-form" onSubmit={onSubmit} aria-label={title || 'Add shelf'}>
    {title && <h3>{title}</h3>}
    {[['code','Shelf code'],['name','Shelf name']].map(([key,label]) => <label key={key}>{label}<input required maxLength={120} disabled={busy} autoFocus={key === 'code'} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
    <label>Inventory category<select aria-label="Inventory category" required disabled={busy} value={form.inventory_kind || 'equipment'} onChange={event => setForm({ ...form, inventory_kind: event.target.value })}><option value="equipment">Equipment · QR per unit</option><option value="consumable">Consumables · QR per shelf</option></select></label>
    <div className="inventory-buttons"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save shelf'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>
}

export function AddShelfDialog({ onClose, onSaved }) {
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
      const { data, error: failure } = await saveShelf(null, form)
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

export function ItemManagement({ shelves, onChange, onQR, onUnitQR, permanentDeleteRequired = false }) {
  const [editing, setEditing] = useState(null), [form, setForm] = useState(emptyShelf)
  const [selectedId, setSelectedId] = useState(''), [query, setQuery] = useState('')
  const [unit, setUnit] = useState(null), [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const selected = shelves.find(shelf => shelf.id === selectedId)
  async function run(action, message) {
    setBusy(true); setError(''); setSuccess('')
    try {
      const { error: failure } = await action()
      if (failure) throw failure
      setSuccess(message); setEditing(null); setUnit(null); await onChange()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  function edit(shelf) { setForm(shelf || emptyShelf); setEditing(shelf?.id || 'new'); setError(''); setSuccess('') }
  function save(event) {
    event.preventDefault()
    run(() => saveShelf(editing === 'new' ? null : editing, form), 'Shelf saved. Receive stock from the Stock Movements page.')
  }
  function removeShelf(shelf) {
    if (busy || permanentDeleteRequired || activeUnits(shelf).length > 0) return
    if (!window.confirm(`Permanently delete shelf "${shelf.name}" (${shelf.code}) from the database? This cannot be undone. Historical transaction records will remain.`)) return
    run(() => supabase.rpc('inventory_delete_shelf', { p_id: shelf.id }), 'Shelf permanently deleted from the database.')
  }
  return <section className="card page inventory-feature"><div className="cardhead"><div><h2>Items and shelves</h2><p>Choose equipment or consumables, manage stock, and generate the correct QR labels.</p></div><button className="primary" onClick={() => edit(null)} disabled={busy}>Add shelf</button></div>
    <Message error={error} success={success}/>
    <label className="inventory-search">Search shelves<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, code, or item type"/></label>
    {editing && <ShelfForm form={form} setForm={setForm} onSubmit={save} onCancel={() => setEditing(null)} busy={busy} title={editing === 'new' ? 'Add shelf' : 'Edit shelf'}/>}
    <div className="inventory-table"><table><thead><tr><th>Shelf</th><th>Item type</th><th>Total</th><th>Available</th><th>Threshold</th><th>Actions</th></tr></thead><tbody>{shelves.filter(shelf => `${shelf.code} ${shelf.name} ${shelf.item_type}`.toLowerCase().includes(query.toLowerCase())).map(shelf => <tr key={shelf.id}><td><b>{shelf.name}</b><br/>{shelf.code}</td><td>{shelf.item_type}<br/><small>{isConsumableShelf(shelf) ? 'Consumables · shelf QR' : 'Equipment · unit QR'}</small></td><td>{activeUnits(shelf).length}</td><td><span className={'badge ' + (isLowStock(shelf) ? 'bad' : '')}>{availableUnits(shelf).length}</span></td><td>{shelf.low_stock_threshold ?? 2}</td><td><div className="inventory-buttons"><button className="secondary" disabled={busy} onClick={() => edit(shelf)}>Edit</button><button className="secondary" onClick={() => setSelectedId(shelf.id)}>Units</button><button className="secondary" onClick={() => onQR(shelf)}>{isConsumableShelf(shelf) ? 'Shelf QR' : 'Equipment QRs'}</button><button className="secondary" disabled={busy || permanentDeleteRequired || activeUnits(shelf).length > 0} onClick={() => removeShelf(shelf)} title={permanentDeleteRequired ? 'Complete the permanent deletion database update' : 'Move or delete all units first'}>Delete shelf</button></div></td></tr>)}</tbody></table></div>
    {!shelves.length && <p className="empty">Add a shelf to start managing inventory.</p>}
    {selected && <div className="inventory-units"><h3>{selected.name} · unit management</h3><p>Use Stock Movements to receive or remove stock. Borrowed units must be returned before editing. {isConsumableShelf(selected) ? 'Consumables use one QR on the shelf.' : 'Each equipment unit has its own QR label.'}</p><div className="inventory-table"><table><thead><tr><th>Unit</th><th>Status</th><th>Condition</th><th>Comment</th><th>Action</th></tr></thead><tbody>{activeUnits(selected).map(item => <tr key={item.id}><td>{item.unit_number}</td><td>{item.status.replaceAll('_',' ')}</td><td>{item.condition}</td><td>{item.comment || '—'}</td><td><button className="secondary" disabled={busy || item.status === 'borrowed'} onClick={() => setUnit({ ...item })}>Edit unit</button>{!isConsumableShelf(selected) && <button className="secondary" onClick={() => onUnitQR(selected, item)}>Unit QR</button>}</td></tr>)}</tbody></table></div></div>}
    {unit && <form className="inventory-form" onSubmit={event => { event.preventDefault(); run(() => supabase.rpc('inventory_update_unit', { p_id: unit.id, p_status: unit.status, p_condition: unit.condition, p_comment: unit.comment || '' }), 'Unit updated.') }}><h3>Edit unit {unit.unit_number}</h3><label>Status<select value={unit.status} onChange={event => setUnit({ ...unit, status: event.target.value })}>{['available','under_maintenance','missing','not_found'].map(status => <option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select></label><label>Condition<select value={unit.condition} onChange={event => setUnit({ ...unit, condition: event.target.value })}><option value="good">Good</option><option value="damaged">Damaged</option></select></label><label>Comment<textarea maxLength={1000} value={unit.comment || ''} onChange={event => setUnit({ ...unit, comment: event.target.value })}/></label><div className="inventory-buttons"><button className="primary" disabled={busy}>Save unit</button><button type="button" className="secondary" disabled={busy} onClick={() => setUnit(null)}>Cancel</button></div></form>}
  </section>
}

export function StockMovements({ shelves, onChange }) {
  const [shelfId, setShelfId] = useState(''), [direction, setDirection] = useState('in'), [quantity, setQuantity] = useState(1), [notes, setNotes] = useState('')
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const shelf = shelves.find(item => item.id === shelfId)
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('')
    try {
      const { error: failure } = await supabase.rpc('inventory_stock_move', { p_shelf_id: shelfId, p_direction: direction, p_quantity: Number(quantity), p_notes: notes.trim() })
      if (failure) throw failure
      setSuccess(`${quantity} unit(s) recorded as stock-${direction}.`); setNotes(''); setQuantity(1)
      setRevision(value => value + 1); await onChange()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <><section className="card inventory-feature"><h2>Record stock movement</h2><p>Stock-in receives stock. Stock-out issues consumables or removes available equipment while keeping history. Scan a consumable shelf QR to issue supplies, or an equipment QR to borrow or return that unit.</p><Message error={error} success={success}/><form className="inventory-form" onSubmit={save}><label>Shelf<select required value={shelfId} onChange={event => setShelfId(event.target.value)}><option value="">Choose a shelf</option>{shelves.map(item => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Movement<select value={direction} onChange={event => setDirection(event.target.value)}><option value="in">Stock-in / receive</option><option value="out">{isConsumableShelf(shelf) ? 'Stock-out / issue consumables' : 'Stock-out / remove'}</option></select></label><label>Quantity<input type="number" required min="1" max={direction === 'out' ? Math.min(1000, availableUnits(shelf || {}).length) : 1000} step="1" value={quantity} onChange={event => setQuantity(event.target.value)}/></label><label>{direction === 'out' ? 'Removal reason (required)' : 'Receipt notes'}<textarea required={direction === 'out'} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)}/></label>{shelf && <p>{availableUnits(shelf).length} available units on this shelf.</p>}<button className="primary" disabled={busy || !shelf || (direction === 'out' && !availableUnits(shelf).length)}>{busy ? 'Saving…' : 'Record movement'}</button></form></section><MovementReport key={revision} shelves={shelves} title="Stock movement history"/></>
}

export function Reports({ shelves }) {
  const [query, setQuery] = useState(''), [onlyLow, setOnlyLow] = useState(false)
  const summary = inventorySummary(shelves).filter(row => `${row.code} ${row.name} ${row.item_type}`.toLowerCase().includes(query.toLowerCase()) && (!onlyLow || row.low_stock === 'Yes'))
  const fields = ['code','name','item_type','total','available','borrowed','damaged','maintenance','missing','threshold','low_stock']
  const headers = ['Code','Name','Item type','Total','Available','Borrowed','Damaged','Maintenance','Missing / not found','Threshold','Low stock']
  return <><section className="card inventory-feature"><div className="cardhead"><div><h2>Inventory summary</h2><p>Current active inventory. Damaged and maintenance counts may overlap.</p></div><button className="primary" onClick={() => downloadCsv('inventoscan-inventory.csv',headers,summary.map(row => fields.map(field => row[field])))}>Export summary CSV</button></div><div className="inventory-filters"><label>Search<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Shelf or item type"/></label><label className="inventory-checkbox"><input type="checkbox" checked={onlyLow} onChange={event => setOnlyLow(event.target.checked)}/>Low stock only</label></div><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{summary.map(row => <tr key={row.code}>{fields.map(field => <td key={field}>{row[field]}</td>)}</tr>)}</tbody></table></div>{!summary.length && <p className="empty">No inventory matches these filters.</p>}</section><MovementReport shelves={shelves}/></>
}

function MovementReport({ shelves, title = 'Stock movement report' }) {
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
  }, [from,to,shelfId,direction,reload])
  const headers = ['Date','Shelf','Unit','Direction','Reason','Quantity','Operator','Notes']
  const values = row => [new Date(row.created_at).toLocaleString(),row.shelf_code || row.shelves?.code || '',row.unit_number ?? row.inventory_units?.unit_number,row.direction,row.reason,row.quantity,row.actor,row.notes || '']
  return <section className="card inventory-feature"><div className="cardhead"><div><h2>{title}</h2><p>{loading ? 'Loading movements…' : `${rows.length} unit movements`}</p></div><div className="inventory-buttons"><button className="secondary" disabled={loading} onClick={() => setReload(value => value+1)}>Refresh</button><button className="primary" disabled={loading || !!error || !rows.length} onClick={() => downloadCsv('inventoscan-movements.csv',headers,rows.map(values))}>Export movements CSV</button></div></div><div className="inventory-filters"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label>Through<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label><label>Shelf<select value={shelfId} onChange={event => setShelfId(event.target.value)}><option value="">All shelf history</option>{shelves.map(shelf => <option key={shelf.id} value={shelf.id}>{shelf.code}</option>)}</select></label><label>Direction<select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">All</option><option value="in">In</option><option value="out">Out</option><option value="adjustment">Adjustment</option></select></label></div><Message error={error}/>{!loading && !error && <><p className="inventory-totals">Stock-in: {rows.filter(row => row.direction==='in').length} · Stock-out: {rows.filter(row => row.direction==='out').length} · Adjustments: {rows.filter(row => row.direction==='adjustment').length}</p><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{values(row).map((value,index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>{!rows.length && <p className="empty">No movements match these filters. Recording starts when the inventory migration is applied.</p>}</>}</section>
}

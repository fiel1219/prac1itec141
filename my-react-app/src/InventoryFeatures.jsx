import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { activeUnits, availableUnits, isLowStock, inventorySummary, downloadCsv } from './lib/inventory'
import './InventoryFeatures.css'

function Message({ error, success }) {
  return <>{error && <div role="alert" className="connection-error">{error}</div>}{success && <div role="status" className="success-message">{success}</div>}</>
}

export function LowStockAlerts({ shelves }) {
  const low = shelves.filter(isLowStock)
  return <section className="card inventory-alerts" aria-label="Low-stock alerts"><h2>Low-stock alerts</h2>{low.length ? <ul>{low.map(shelf => <li key={shelf.id}><b>{shelf.name}</b> ({shelf.code}): {availableUnits(shelf).length} available · threshold {shelf.low_stock_threshold ?? 2}</li>)}</ul> : <p>All shelves are above their low-stock thresholds.</p>}</section>
}

const emptyShelf = { code: '', name: '', item_type: '', low_stock_threshold: 2 }
export function ItemManagement({ shelves, onChange, onQR }) {
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
    run(() => supabase.rpc('inventory_save_shelf', { p_id: editing === 'new' ? null : editing, p_code: form.code, p_name: form.name, p_item_type: form.item_type, p_threshold: Number(form.low_stock_threshold) }), 'Shelf saved. Receive stock from the Stock Movements page.')
  }
  function archive(shelf) {
    if (!window.confirm(`Archive ${shelf.name}? Its QR label will no longer be active. History will be kept.`)) return
    run(() => supabase.rpc('inventory_archive_shelf', { p_id: shelf.id }), 'Shelf archived.')
  }
  return <section className="card page inventory-feature"><div className="cardhead"><div><h2>Items and shelves</h2><p>Manage shelf details, low-stock thresholds, and individual unit conditions.</p></div><button className="primary" onClick={() => edit(null)} disabled={busy}>Add shelf</button></div>
    <Message error={error} success={success}/>
    <label className="inventory-search">Search shelves<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, code, or item type"/></label>
    {editing && <form className="inventory-form" onSubmit={save}><h3>{editing === 'new' ? 'Add shelf' : 'Edit shelf'}</h3>{[['code','Shelf code'],['name','Shelf name'],['item_type','Item / product type']].map(([key,label]) => <label key={key}>{label}<input required maxLength={120} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}<label>Low-stock threshold<input type="number" min="0" max="1000000" step="1" required value={form.low_stock_threshold} onChange={event => setForm({ ...form, low_stock_threshold: event.target.value })}/></label><div className="inventory-buttons"><button className="primary" disabled={busy}>Save shelf</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div></form>}
    <div className="inventory-table"><table><thead><tr><th>Shelf</th><th>Item type</th><th>Total</th><th>Available</th><th>Threshold</th><th>Actions</th></tr></thead><tbody>{shelves.filter(shelf => `${shelf.code} ${shelf.name} ${shelf.item_type}`.toLowerCase().includes(query.toLowerCase())).map(shelf => <tr key={shelf.id}><td><b>{shelf.name}</b><br/>{shelf.code}</td><td>{shelf.item_type}</td><td>{activeUnits(shelf).length}</td><td><span className={'badge ' + (isLowStock(shelf) ? 'bad' : '')}>{availableUnits(shelf).length}</span></td><td>{shelf.low_stock_threshold ?? 2}</td><td><div className="inventory-buttons"><button className="secondary" disabled={busy} onClick={() => edit(shelf)}>Edit</button><button className="secondary" onClick={() => setSelectedId(shelf.id)}>Units</button><button className="secondary" onClick={() => onQR(shelf)}>QR</button><button className="secondary" disabled={busy || activeUnits(shelf).length > 0} onClick={() => archive(shelf)} title="Remove all stock before archiving">Archive</button></div></td></tr>)}</tbody></table></div>
    {!shelves.length && <p className="empty">Add a shelf to start managing inventory.</p>}
    {selected && <div className="inventory-units"><h3>{selected.name} · unit management</h3><p>Use Stock Movements to receive or remove stock. Borrowed units must be returned before editing.</p><div className="inventory-table"><table><thead><tr><th>Unit</th><th>Status</th><th>Condition</th><th>Comment</th><th>Action</th></tr></thead><tbody>{activeUnits(selected).map(item => <tr key={item.id}><td>{item.unit_number}</td><td>{item.status.replaceAll('_',' ')}</td><td>{item.condition}</td><td>{item.comment || '—'}</td><td><button className="secondary" disabled={busy || item.status === 'borrowed'} onClick={() => setUnit({ ...item })}>Edit unit</button></td></tr>)}</tbody></table></div></div>}
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
  return <><section className="card inventory-feature"><h2>Record stock movement</h2><p>Stock-in adds new units. Stock-out removes available units permanently while keeping their history. Use Scan QR and Returns for borrowing.</p><Message error={error} success={success}/><form className="inventory-form" onSubmit={save}><label>Shelf<select required value={shelfId} onChange={event => setShelfId(event.target.value)}><option value="">Choose a shelf</option>{shelves.map(item => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Movement<select value={direction} onChange={event => setDirection(event.target.value)}><option value="in">Stock-in / receive</option><option value="out">Stock-out / remove</option></select></label><label>Quantity<input type="number" required min="1" max={direction === 'out' ? Math.min(1000, availableUnits(shelf || {}).length) : 1000} step="1" value={quantity} onChange={event => setQuantity(event.target.value)}/></label><label>{direction === 'out' ? 'Removal reason (required)' : 'Receipt notes'}<textarea required={direction === 'out'} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)}/></label>{shelf && <p>{availableUnits(shelf).length} available units on this shelf.</p>}<button className="primary" disabled={busy || !shelf || (direction === 'out' && !availableUnits(shelf).length)}>{busy ? 'Saving…' : 'Record movement'}</button></form></section><MovementReport key={revision} shelves={shelves} title="Stock movement history"/></>
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
  const values = row => [new Date(row.created_at).toLocaleString(),row.shelves?.code || '',row.inventory_units?.unit_number,row.direction,row.reason,row.quantity,row.actor,row.notes || '']
  return <section className="card inventory-feature"><div className="cardhead"><div><h2>{title}</h2><p>{loading ? 'Loading movements…' : `${rows.length} unit movements`}</p></div><div className="inventory-buttons"><button className="secondary" disabled={loading} onClick={() => setReload(value => value+1)}>Refresh</button><button className="primary" disabled={loading || !!error || !rows.length} onClick={() => downloadCsv('inventoscan-movements.csv',headers,rows.map(values))}>Export movements CSV</button></div></div><div className="inventory-filters"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label>Through<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label><label>Shelf<select value={shelfId} onChange={event => setShelfId(event.target.value)}><option value="">All shelves (including archived)</option>{shelves.map(shelf => <option key={shelf.id} value={shelf.id}>{shelf.code}</option>)}</select></label><label>Direction<select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">All</option><option value="in">In</option><option value="out">Out</option><option value="adjustment">Adjustment</option></select></label></div><Message error={error}/>{!loading && !error && <><p className="inventory-totals">Stock-in: {rows.filter(row => row.direction==='in').length} · Stock-out: {rows.filter(row => row.direction==='out').length} · Adjustments: {rows.filter(row => row.direction==='adjustment').length}</p><div className="inventory-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{values(row).map((value,index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>{!rows.length && <p className="empty">No movements match these filters. Recording starts when the inventory migration is applied.</p>}</>}</section>
}

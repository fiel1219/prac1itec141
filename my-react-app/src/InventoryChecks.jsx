import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { itemLabel, itemName } from './lib/inventory'
import { checkSubmission, countedQuantity, inspectionItems, inspectionResultText, isInspectionReviewed, loadInventoryChecks, quantityDifferenceLabel } from './lib/inventoryChecks'
import './InventoryChecks.css'

function InspectionItem({ item, shelf, finding = {}, disabled, update }) {
  const consumable = item.inventory_kind === 'consumable'
  const reference = itemLabel(item, shelf)
  const actual = consumable ? countedQuantity(item, finding) : null
  const options = consumable ? [['matches', 'Good · matches record'], ['different', 'Different quantity']] : [['good', 'Good'], ['damaged', 'Damaged']]
  const field = consumable ? 'count_result' : 'condition'
  return <article className={`check-item${item.skip_reason ? ' check-item-skipped' : ''}`}>
    <div className="check-item-info"><b>{itemName(item, shelf)}</b><span>{reference}{consumable && ` · Recorded quantity: ${item.check_quantity}`}</span><small>Recorded: {item.condition} · {item.status.replaceAll('_', ' ')}</small>{item.description && <p>{item.description}</p>}</div>
    {item.skip_reason ? <p className="check-skip-reason">{item.skip_reason}</p> : <div className="check-item-controls">
      <fieldset disabled={disabled}><legend>{consumable ? 'Quantity' : 'Condition'} of {reference}</legend><div className="check-condition-options">{options.map(([value, label]) => <label className={finding[field] === value ? `selected ${value}` : ''} key={value}><input type="radio" required name={`${field}-${item.id}`} value={value} checked={finding[field] === value} onChange={() => update(item.id, field, value)}/>{label}</label>)}</div></fieldset>
      {consumable && finding.count_result === 'different' && <div className="check-count">
        <label>Actual quantity<input aria-label={`Actual quantity for ${reference}`} type="number" required min="0" max="2147483647" step="1" disabled={disabled} value={finding.actual_quantity ?? ''} onChange={event => update(item.id, 'actual_quantity', event.target.value)}/></label>
        {actual !== null && <p className={actual === item.check_quantity ? 'check-count-warning' : 'check-count-difference'}>{actual === item.check_quantity ? 'This count matches the record. Select Good · matches record.' : `${quantityDifferenceLabel(actual, item.check_quantity)} · saved for review`}</p>}
      </div>}
      <label className="check-note">Observation (optional)<input aria-label={`Observation for ${reference}`} maxLength={1000} disabled={disabled} value={finding.notes || ''} onChange={event => update(item.id, 'notes', event.target.value)} placeholder={consumable ? 'e.g. counted 40 instead of 50' : 'e.g. cracked screen'}/></label>
    </div>}
  </article>
}

export default function InventoryChecks({ laboratoryId, shelves, onChange, inventoryLoading, inventoryError, setupRequired }) {
  const [shelfId, setShelfId] = useState(''), [snapshot, setSnapshot] = useState(null)
  const [findings, setFindings] = useState({}), [comments, setComments] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const [history, setHistory] = useState([]), [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState(''), [checkSetupRequired, setCheckSetupRequired] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  useEffect(() => {
    let active = true
    if (!supabase) return
    loadInventoryChecks(supabase, laboratoryId, shelfId).then(result => {
      if (!active) return
      setHistory(result.data || []); setHistoryError(result.error?.message || ''); setCheckSetupRequired(Boolean(result.setupRequired)); setHistoryLoading(false)
    }).catch(failure => { if (active) { setHistoryError(failure.message); setHistoryLoading(false) } })
    return () => { active = false }
  }, [laboratoryId, shelfId, historyVersion])
  const items = snapshot ? inspectionItems(snapshot) : []
  const inspectable = items.filter(item => !item.skip_reason)
  const reviewed = inspectable.filter(item => isInspectionReviewed(item, findings[item.id])).length
  const dirty = Object.keys(findings).length > 0 || Boolean(comments.trim())
  const shelfExists = shelves.some(shelf => shelf.id === shelfId)
  function selectShelf(id) {
    if (busy || (dirty && !window.confirm('Discard this unfinished inventory check?'))) return
    setShelfId(id); setSnapshot(shelves.find(shelf => shelf.id === id) || null)
    setFindings({}); setComments(''); setError(''); setSuccess(''); setHistoryLoading(true)
    if (id === shelfId) setHistoryVersion(value => value + 1)
  }
  function update(id, field, value) {
    setFindings(previous => ({ ...previous, [id]: { ...previous[id], [field]: value } }))
    setError(''); setSuccess('')
  }
  async function save(event) {
    event.preventDefault()
    if (busy || !snapshot || setupRequired || checkSetupRequired || historyLoading || inventoryLoading || inventoryError || !shelfExists) return
    if (!inspectable.length || reviewed !== inspectable.length) { setError('Review every equipment condition and consumable quantity before saving.'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      const { error: failure } = await supabase.rpc('inventory_save_categorized_shelf_check', {
        p_laboratory_id: laboratoryId, p_shelf_id: shelfId,
        p_items: checkSubmission(items, findings), p_comments: comments.trim(),
      })
      if (failure) throw failure
      setSnapshot(null); setFindings({}); setComments('')
      setSuccess('Inventory check saved.')
      setHistoryLoading(true); setHistoryVersion(value => value + 1)
      const refreshed = await onChange()
      if (refreshed === false) setError('Your check was saved, but inventory could not be refreshed. Reload before starting another check.')
    } catch (failure) {
      setError(failure.code === 'PGRST202' ? 'Inventory checks need a system update. Please contact your System Admin.' : failure.message)
    } finally { setBusy(false) }
  }
  return <section className="card page inventory-checks-page">
    <div className="cardhead"><div><h2>Inventory Checks</h2><p>Choose a shelf to check equipment conditions and consumable quantities.</p></div></div>
    {(setupRequired || checkSetupRequired) && <p className="connection-error" role="status">Inventory checks need a system update. Ask your System Admin to complete setup before saving checks.</p>}
    {error && <p role="alert" className="connection-error">{error}</p>}
    {success && <p role="status" className="success-message">{success}</p>}
    <div className="check-shelf-picker"><label>Choose shelf<select aria-label="Choose shelf" value={shelfId} disabled={busy || inventoryLoading || Boolean(inventoryError)} onChange={event => selectShelf(event.target.value)}>
      <option value="">Select a shelf to inspect</option>{shelfId && !shelfExists && <option value={shelfId}>Shelf no longer available</option>}
      {shelves.map(shelf => <option key={shelf.id} value={shelf.id}>{shelf.code} · {shelf.name}</option>)}
    </select></label>{shelfId && <button type="button" className="secondary" disabled={busy || inventoryLoading || Boolean(inventoryError) || !shelfExists} onClick={() => selectShelf(shelfId)}>{snapshot ? 'Reload shelf items' : 'Start another check'}</button>}</div>
    {!shelves.length && !inventoryLoading && !inventoryError && <p className="empty">No shelves in this laboratory yet.</p>}
    {!shelfId && shelves.length > 0 && <p className="empty">Select a shelf to see its equipment and consumables.</p>}
    {snapshot && <form aria-label="Shelf inventory check" onSubmit={save}>
      <div className="check-progress"><h3>{snapshot.code} · {snapshot.name}</h3><span>{reviewed} of {inspectable.length} records reviewed</span></div>
      {!shelfExists && <p role="alert" className="connection-error">This shelf is no longer available. Select another shelf.</p>}
      {!items.length ? <p className="empty">This shelf has no items to check.</p> : [['equipment', 'Equipment'], ['consumable', 'Consumables']].map(([kind, title]) => {
        const categoryItems = items.filter(item => item.inventory_kind === kind)
        return <section className="check-category" aria-label={`${title} checks`} key={kind}>
          <h3>{title} <span>{categoryItems.length}</span></h3>
          <p className="check-help">{kind === 'equipment' ? 'Mark equipment Good or Damaged. Damaged equipment is placed under maintenance.' : 'Good means the physical count matches the record. For a difference, enter the actual count. Counts and differences are saved for review.'}</p>
          {!categoryItems.length ? <p className="check-help">No {title.toLowerCase()} on this shelf.</p> : <div className="check-item-list">{categoryItems.map(item => <InspectionItem key={item.id} item={item} shelf={snapshot} finding={findings[item.id]} disabled={busy || !shelfExists} update={update}/>)}</div>}
        </section>
      })}
      {items.length > 0 && !inspectable.length && <p role="status">No items are available for inspection. Borrowed and missing items must be resolved first.</p>}
      {inspectable.length > 0 && <><label className="check-comments">Check notes (optional)<textarea aria-label="Check notes" maxLength={1000} disabled={busy} value={comments} onChange={event => setComments(event.target.value)}/></label><div className="check-save"><span>{reviewed === inspectable.length ? 'All inspectable items reviewed.' : 'Review each equipment condition and consumable quantity.'}</span><button type="submit" className="primary" disabled={busy || inventoryLoading || Boolean(inventoryError) || setupRequired || checkSetupRequired || historyLoading || reviewed !== inspectable.length || !shelfExists}>{busy ? 'Saving…' : 'Save inventory check'}</button></div></>}
    </form>}
    <section className="check-history" aria-label="Recent inventory checks"><h3>{shelfId ? 'Recent checks for this shelf' : 'Recent laboratory checks'}</h3>
      {historyLoading ? <p role="status">Loading checks…</p> : historyError ? <p role="alert" className="connection-error">{historyError} <button type="button" className="secondary" onClick={() => { setHistoryLoading(true); setHistoryVersion(value => value + 1) }}>Retry</button></p> : !history.length ? <p>No saved checks yet.</p> : <><p className="check-help">Latest 10 checks</p>{history.map(check => <details key={check.id}>
        <summary><b>{check.shelf_code} · {check.shelf_name}</b><span>{new Date(check.checked_at).toLocaleString()} · {check.performed_by}</span><span>{check.present_units} inspected · {check.damaged_units} damaged · {check.skipped_units || 0} skipped{check.quantity_discrepancies > 0 && ` · ${check.quantity_discrepancies} quantity ${check.quantity_discrepancies === 1 ? 'difference' : 'differences'}`}</span></summary>
        {check.comments && <p className="check-history-notes">{check.comments}</p>}
        <ul>{(check.item_results || []).map(item => <li key={item.unit_id}><b>{item.item_name}</b> · {item.reference} · {inspectionResultText(item)}{item.notes && <p>{item.notes}</p>}</li>)}</ul>
      </details>)}</>}
    </section>
  </section>
}

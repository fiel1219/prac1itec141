import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { fetchBorrowers, fetchInventoryByQR, supabase } from './lib/supabase'
import { activeUnits, availableUnits } from './lib/inventory'
import { equipmentQRValue, isConsumableShelf } from './lib/inventoryQR'
import './InventoryQR.css'

const unitName = unit => `Unit ${String(unit.unit_number).padStart(3, '0')}`

function QRLabel({ shelf, unit }) {
  const [generated, setGenerated] = useState(null), [failure, setFailure] = useState(null)
  const value = unit ? equipmentQRValue(unit) : shelf.qr_value
  const image = generated?.value === value ? generated.image : ''
  const error = failure?.value === value ? failure.message : ''
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, { width: 520, margin: 4 }).then(result => {
      if (!cancelled) { setGenerated({ value, image: result }); setFailure(null) }
    }).catch(error => { if (!cancelled) setFailure({ value, message: error.message }) })
    return () => { cancelled = true }
  }, [value])
  function download() {
    const link = document.createElement('a')
    link.href = image
    link.download = unit ? `equipment-${unit.id}-qr.png` : `${shelf.code}-consumables-qr.png`
    link.click()
  }
  return <><span className="eyebrow">{unit ? 'EQUIPMENT QR CODE' : 'CONSUMABLE SHELF QR CODE'}</span>
    <h2>{unit ? `${shelf.item_type} · ${unitName(unit)}` : shelf.name}</h2>
    <p>{shelf.code} · {unit ? `Permanent ID: ${unit.id}` : shelf.item_type}</p>
    {image ? <img className="qr-image" src={image} alt={unit ? `QR code for equipment ${unit.id}` : `Consumable QR code for shelf ${shelf.code}`}/> : <p>Generating QR…</p>}
    {error && <div role="alert" className="connection-error">{error}</div>}
    <code className="qr-value">{value}</code>
    <button className="primary full" onClick={download} disabled={!image}>Download QR</button></>
}

export function InventoryLabels({ shelf, shelves = [], close, onChange, migrationRequired = false, unitActionsRequired = false, permanentDeleteRequired = false }) {
  const [unitId, setUnitId] = useState(shelf.qrUnit?.id || null)
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('')
  const [action, setAction] = useState(null), [destinationId, setDestinationId] = useState(''), [reason, setReason] = useState('')
  const [savingUnit, setSavingUnit] = useState(false), [unitError, setUnitError] = useState(''), [success, setSuccess] = useState('')
  const [removedIds, setRemovedIds] = useState([])
  const [unitOverrides, setUnitOverrides] = useState({})
  const [returnLoans, setReturnLoans] = useState([]), [returnLoanId, setReturnLoanId] = useState('')
  const [returnCondition, setReturnCondition] = useState('good'), [physicalReturn, setPhysicalReturn] = useState(false), [loadingReturn, setLoadingReturn] = useState(false)
  const body = useRef(null)
  const consumable = isConsumableShelf(shelf)
  const units = activeUnits(shelf).filter(item => !removedIds.includes(item.id)).map(item => ({ ...item,
    ...(unitOverrides[item.id]?.source === shelf.inventory_units ? unitOverrides[item.id].values : {}) }))
  const unit = units.find(item => item.id === unitId)
  const actionUnit = units.find(item => item.id === action?.id)
  const destinations = shelves.filter(item => item.id !== shelf.id && item.status === 'active' && !isConsumableShelf(item)
    && item.item_type.trim().toLowerCase() === shelf.item_type.trim().toLowerCase())
  const hasStock = units.length > 0
  const busy = deleting || savingUnit || loadingReturn
  const actionsUnavailable = migrationRequired || unitActionsRequired
  function requestClose() { if (!busy) close() }
  function openUnitAction(type, item) {
    setAction({ type, id: item.id }); setDestinationId(''); setReason(''); setUnitError(''); setSuccess(''); setUnitId(null)
    body.current?.scrollTo({ top: 0 })
  }
  async function openReturnAction(item) {
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
        ? 'Return status repair needs database setup. Run supabase/inventory_return_repair.sql in Supabase SQL Editor, then try again.'
        : failure.message)
    }
    finally { setSavingUnit(false) }
  }
  async function deleteShelf() {
    if (busy || hasStock || migrationRequired || permanentDeleteRequired) return
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
  return <div className="backdrop inventory-qr-backdrop" onClick={requestClose}><div className="modal qr-modal inventory-qr-modal" role="dialog" aria-modal="true" aria-label="Inventory QR labels" onClick={event => event.stopPropagation()}>
    <button className="x" onClick={requestClose} disabled={busy} aria-label="Close QR labels">×</button>
    <div className="inventory-qr-body" ref={body}>
    {unitError && <div role="alert" className="connection-error">{unitError}</div>}
    {success && <div role="status" className="success-message">{success}</div>}
    {consumable || unit ? <>{!consumable && <button className="secondary" onClick={() => setUnitId(null)}>All equipment units</button>}<QRLabel shelf={shelf} unit={consumable ? null : unit}/></> : <>
      <h2>{shelf.name} · equipment QR labels</h2><p>View QR labels or manage equipment here. Return borrowed equipment before moving or deleting it.</p>
      {actionsUnavailable && <p className="unit-setup-help">Complete the unit management database setup shown on the main page to enable Move and Delete.</p>}
      {actionUnit && <form className="unit-action-form" onSubmit={saveUnitAction}>
        <h3>{action.type === 'move' ? 'Move' : action.type === 'return' ? 'Return' : 'Delete'} {unitName(actionUnit)}</h3>
        {action.type === 'return' ? loadingReturn ? <p role="status">Checking active loans…</p> : <>
          {returnLoans.length ? <label>Active loan<select required disabled={busy} value={returnLoanId} onChange={event => setReturnLoanId(event.target.value)}><option value="">Choose a loan</option>{returnLoans.map(loan => <option key={loan.id} value={loan.id}>{loan.reference} · due {loan.expected_return_at}</option>)}</select></label>
            : <p>This unit is marked borrowed, but has no active loan record. Confirm its physical return to correct its status. Existing transaction history will stay unchanged.</p>}
          <label>Return condition<select disabled={busy} value={returnCondition} onChange={event => setReturnCondition(event.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label>
          {!returnLoans.length && <label className="unit-return-confirmation"><input type="checkbox" required disabled={busy} checked={physicalReturn} onChange={event => setPhysicalReturn(event.target.checked)}/>I confirm this unit is physically back in the laboratory</label>}
        </> : action.type === 'move' ? <><label>Destination shelf<select required disabled={busy} value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Choose a shelf</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
          <p>{destinations.length ? 'Only equipment shelves with the same item type are listed. The unit keeps its permanent ID and QR code. Its display number may change on the new shelf.' : `Add another equipment shelf for ${shelf.item_type} in Items before moving this unit.`}</p></> : <p>This permanently deletes the equipment unit’s database row. This cannot be undone. Historical transaction records will remain.</p>}
        {!(action.type === 'return' && (loadingReturn || returnLoans.length)) && <label>{action.type === 'delete' ? 'Deletion reason' : action.type === 'return' ? 'Return confirmation reason' : 'Move notes (optional)'}<textarea required={action.type !== 'move'} maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)}/></label>}
        <div className="unit-action-buttons"><button className={action.type === 'delete' ? 'delete-unit-button' : 'primary'} disabled={busy || (action.type === 'move' && !destinations.length) || (action.type === 'delete' && permanentDeleteRequired)}>{savingUnit ? 'Saving…' : action.type === 'delete' ? 'Confirm delete' : action.type === 'return' ? 'Confirm return' : 'Confirm move'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setAction(null); setUnitError('') }}>Cancel</button></div>
      </form>}
      <div className="equipment-label-list">{units.map(item => <div key={item.id}><span><b>{unitName(item)}</b><small>{item.status.replaceAll('_', ' ')} · {item.condition}</small><code>{item.id}</code>{item.status === 'borrowed' && <small>Return this unit before moving or deleting it.</small>}</span>
        <div className="unit-action-buttons"><button type="button" className="secondary" disabled={busy} onClick={() => { setUnitId(item.id); setAction(null) }}>View QR</button>{item.status === 'borrowed' && <button type="button" className="secondary" aria-label={`Return ${unitName(item)}`} disabled={busy || migrationRequired} onClick={() => openReturnAction(item)}>Return</button>}<button type="button" className="secondary" aria-label={`Move ${unitName(item)}`} disabled={busy || actionsUnavailable || item.status === 'borrowed'} onClick={() => openUnitAction('move', item)}>Move</button><button type="button" className="delete-unit-button" aria-label={`Delete ${unitName(item)}`} disabled={busy || actionsUnavailable || permanentDeleteRequired || item.status === 'borrowed'} onClick={() => openUnitAction('delete', item)}>Delete</button></div>
      </div>)}</div>
      {!units.length && <p>This shelf is empty. You can delete it below or receive new stock.</p>}
    </>}
    </div>
    <div className="inventory-qr-actions">
      {deleteError && <div role="alert" className="connection-error">{deleteError}</div>}
      <p id="delete-shelf-help">{migrationRequired ? 'Complete the database setup to delete shelves.' : permanentDeleteRequired ? 'Complete the permanent deletion database update shown on the main page.' : hasStock ? consumable ? 'Issue or remove all consumables before deleting this shelf.' : 'Move or delete the remaining units above to empty this shelf. Return borrowed equipment first.' : 'Permanently deletes this shelf from the database. Historical transaction records remain.'}</p>
      <button type="button" className="delete-shelf-button" disabled={busy || hasStock || migrationRequired || permanentDeleteRequired} aria-describedby="delete-shelf-help" onClick={deleteShelf}>{deleting ? 'Deleting…' : 'Delete shelf'}</button>
    </div>
  </div></div>
}

export function InventoryScanner({ onChange, migrationRequired }) {
  const [value, setValue] = useState(''), [result, setResult] = useState(null)
  const [error, setError] = useState(''), [done, setDone] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [scanning, setScanning] = useState(false)
  const [borrowers, setBorrowers] = useState([]), [borrowerId, setBorrowerId] = useState('')
  const [borrowerName, setBorrowerName] = useState(''), [identity, setIdentity] = useState('')
  const [due, setDue] = useState(() => new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10))
  const [quantity, setQuantity] = useState(1), [notes, setNotes] = useState('')
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
    setBorrowerId(''); setBorrowerName(''); setIdentity(''); setQuantity(1); setNotes(''); setCondition('good')
    try {
      const response = await fetchInventoryByQR(code)
      if (version !== lookupVersion.current) return
      if (response.error) throw response.error
      const data = response.data
      if (data.qr_kind === 'equipment') {
        const unit = data.inventory_units[0]
        if (unit.status === 'borrowed') {
          const response = await supabase.from('transactions').select('id,borrowers(name)').eq('unit_id', unit.id).is('returned_at', null).maybeSingle()
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
        const count = Number(quantity)
        if (!Number.isInteger(count) || count < 1 || count > Math.min(1000, availableUnits(result).length)) throw new Error('Enter an available whole-number quantity from 1 to 1000.')
        if (!notes.trim()) throw new Error('Enter the issue reason or recipient.')
        const { error } = await supabase.rpc('inventory_stock_move', { p_shelf_id: result.id, p_direction: 'out', p_quantity: count, p_notes: notes.trim() })
        if (error) throw error
        success = `${count} consumable unit(s) issued.`
      } else if (loan) {
        const { error } = await supabase.rpc('inventory_return', { p_transaction_id: loan.id, p_condition: condition })
        if (error) throw error
        success = 'Equipment return recorded.'
      } else {
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
  const available = result ? availableUnits(result).length : 0
  return <section className="card page inventory-scanner">
    <div className="cardhead"><div><h2>Scan inventory QR</h2><p>Scan an equipment unit or a consumable shelf label.</p></div></div>
    {migrationRequired ? <p>Complete the database setup shown above to use equipment and consumable QR scanning.</p> : <>
      <div className="scanner-grid"><div className="scanner-camera"><video ref={video} muted playsInline/>{!scanning && <div className="camera-placeholder">▣<span>Camera preview</span></div>}</div>
        <div className="scanner-controls"><button className="primary" disabled={busy || loading} onClick={scanning ? stopCamera : startCamera}>{scanning ? 'Stop camera' : 'Open camera'}</button>
          <form className="scan-input" onSubmit={event => { event.preventDefault(); lookup() }}><input aria-label="QR value" value={value} disabled={busy || loading} onChange={event => setValue(event.target.value)} placeholder="Equipment QR or consumable shelf QR"/><button disabled={busy || loading}>{loading ? 'Searching…' : 'Search'}</button></form>
          <small>Allow camera access when prompted, or paste the value printed with a QR label.</small></div></div>
      {error && <div role="alert" className="connection-error">{error}</div>}
      {done && <div role="status" className="success-message">{done}</div>}
      {result && <div className="inventory-qr-result"><div><span className="eyebrow">{unit ? 'EQUIPMENT FOUND' : 'CONSUMABLE SHELF FOUND'}</span><h2>{unit ? `${result.item_type} · ${unitName(unit)}` : result.name}</h2><p>{result.code} · {result.item_type}</p>
        {unit ? <><code className="qr-value">Permanent ID: {unit.id}</code><p>Status: {unit.status.replaceAll('_', ' ')} · Condition: {unit.condition}</p>{unit.comment && <p>{unit.comment}</p>}</> : <p><b>{available}</b> available consumable units on this shelf.</p>}</div>
        <form className="checkout-form" onSubmit={transact}>
          {!unit ? <><h3>Issue consumables</h3><label>Quantity<input required type="number" min="1" max={Math.min(1000, available)} step="1" disabled={busy} value={quantity} onChange={event => setQuantity(event.target.value)}/></label><label>Issue reason / recipient<textarea required maxLength={1000} disabled={busy} value={notes} onChange={event => setNotes(event.target.value)}/></label></> : loan ? <><h3>Return this equipment</h3><p>Borrower: {loan.borrowers?.name || 'See transaction history'}</p><label>Return condition<select value={condition} disabled={busy} onChange={event => setCondition(event.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label></> : available ? <>
            <h3>Borrow this equipment</h3><label>Borrower<select disabled={busy} value={borrowerId} onChange={event => setBorrowerId(event.target.value)}><option value="">Choose a borrower or enter a new one</option>{borrowers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.identity_number}</option>)}</select></label>
            <div className="new-borrower"><label>New borrower name<input disabled={busy} value={borrowerName} onChange={event => { setBorrowerName(event.target.value); setBorrowerId('') }}/></label><label>Student / employee ID<input disabled={busy} value={identity} onChange={event => { setIdentity(event.target.value); setBorrowerId('') }}/></label></div><label>Expected return date<input required type="date" disabled={busy} value={due} onChange={event => setDue(event.target.value)}/></label>
          </> : <p>This unit is unavailable for borrowing. Review its status and condition in Items.</p>}
          <button className="primary" disabled={busy || (!loan && !available)}>{busy ? 'Saving…' : !unit ? 'Confirm issue' : loan ? 'Confirm return' : 'Confirm checkout'}</button>
        </form></div>}
    </>}
  </section>
}

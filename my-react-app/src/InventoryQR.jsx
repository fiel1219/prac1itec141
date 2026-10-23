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

export function InventoryLabels({ shelf, close, onChange, migrationRequired = false }) {
  const [unit, setUnit] = useState(shelf.qrUnit || null)
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('')
  const consumable = isConsumableShelf(shelf)
  const hasStock = activeUnits(shelf).length > 0
  function requestClose() { if (!deleting) close() }
  async function deleteShelf() {
    if (deleting || hasStock || migrationRequired) return
    if (!window.confirm(`Delete shelf "${shelf.name}" (${shelf.code})? It will be archived and removed from active inventory. Transaction history will be kept.`)) return
    setDeleting(true); setDeleteError('')
    try {
      const { error } = await supabase.rpc('inventory_archive_shelf', { p_id: shelf.id })
      if (error) throw error
      await onChange()
      close()
    } catch (failure) { setDeleteError(failure.message) }
    finally { setDeleting(false) }
  }
  return <div className="backdrop inventory-qr-backdrop" onClick={requestClose}><div className="modal qr-modal inventory-qr-modal" role="dialog" aria-modal="true" aria-label="Inventory QR labels" onClick={event => event.stopPropagation()}>
    <button className="x" onClick={requestClose} disabled={deleting} aria-label="Close QR labels">×</button>
    <div className="inventory-qr-body">
    {consumable || unit ? <>{!consumable && <button className="secondary" onClick={() => setUnit(null)}>All equipment units</button>}<QRLabel shelf={shelf} unit={consumable ? null : unit}/></> : <>
      <h2>{shelf.name} · equipment QR labels</h2><p>Attach a separate QR code to each equipment unit. Scanning opens that unit’s record.</p>
      <div className="equipment-label-list">{activeUnits(shelf).map(item => <div key={item.id}><span><b>{unitName(item)}</b><small>{item.status.replaceAll('_', ' ')} · {item.condition}</small><code>{item.id}</code></span><button className="secondary" onClick={() => setUnit(item)}>View QR</button></div>)}</div>
      {!activeUnits(shelf).length && <p>Receive equipment stock to generate unit QR labels.</p>}
    </>}
    </div>
    <div className="inventory-qr-actions">
      {deleteError && <div role="alert" className="connection-error">{deleteError}</div>}
      <p id="delete-shelf-help">{migrationRequired ? 'Complete the database setup to delete shelves.' : hasStock ? 'Remove or issue all stock in Stock Movements before deleting this shelf. Return borrowed equipment first.' : 'Deleting archives this shelf and keeps its transaction history.'}</p>
      <button type="button" className="delete-shelf-button" disabled={deleting || hasStock || migrationRequired} aria-describedby="delete-shelf-help" onClick={deleteShelf}>{deleting ? 'Deleting…' : 'Delete shelf'}</button>
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
          if (!response.data) throw new Error('No active loan was found for this borrowed unit. Review its transaction history.')
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

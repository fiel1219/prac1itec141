import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import './Laboratories.css'

export function LaboratorySelector({ laboratories, selectedId, onSelect, onManage, loading }) {
  return <div className="laboratory-switcher">
    <select className="workspace" aria-label="Laboratory" value={selectedId || ''} disabled={loading || !laboratories.length} onChange={event => onSelect(event.target.value)}>
      {!laboratories.length && <option value="">{loading ? 'Loading laboratories…' : onManage ? 'No laboratories yet' : 'No assigned laboratories'}</option>}
      {laboratories.map(lab => <option key={lab.id} value={lab.id}>{lab.name}</option>)}
    </select>
    {onManage && <button type="button" className="manage-laboratories" disabled={loading} onClick={onManage}>Manage laboratories</button>}
  </div>
}

export function LaboratoryManager({ laboratories, shelves, onChange, onClose, setupRequired }) {
  const [action,setAction] = useState(null), [name,setName] = useState(''), [description,setDescription] = useState('')
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [success,setSuccess] = useState('')
  const shelfCount = id => shelves.filter(shelf => shelf.laboratory_id === id).length
  const blockedDelete = action?.type === 'delete' && shelfCount(action.id)>0
  function close() { if (!busy) onClose() }
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown',escape)
    return () => document.removeEventListener('keydown',escape)
  }, [busy,onClose])
  function open(type,lab) {
    setAction({ type,id:lab?.id });setName(lab?.name || '');setDescription(lab?.description || '')
    setError('');setSuccess('')
  }
  async function save(event) {
    event.preventDefault()
    if (busy || setupRequired || !action || blockedDelete) return
    if (action.type !== 'delete' && !name.trim()) { setError('Enter a laboratory name.');return }
    setBusy(true);setError('');setSuccess('')
    try {
      const { data,error:failure } = action.type === 'delete'
        ? await supabase.rpc('inventory_delete_laboratory',{ p_id:action.id })
        : await supabase.rpc('inventory_save_laboratory',{ p_id:action.id || null,p_name:name.trim(),p_description:description.trim() })
      if (failure) throw failure
      const message = action.type === 'delete' ? 'Laboratory deleted.' : action.type === 'add' ? 'Laboratory added.' : 'Laboratory updated.'
      const preferredId = action.type === 'add' ? data : undefined
      setAction(null)
      await onChange(preferredId)
      setSuccess(message)
    } catch (failure) {
      setError(failure.code === 'PGRST202' ? 'Laboratory management needs a system update. Please contact an administrator.' : failure.message)
    } finally { setBusy(false) }
  }
  return <div className="backdrop laboratory-backdrop" onClick={close}><div className="modal laboratory-modal" role="dialog" aria-modal="true" aria-labelledby="laboratories-title" onClick={event => event.stopPropagation()}>
    <button className="x" type="button" disabled={busy} onClick={close} aria-label="Close laboratories">×</button>
    <h2 id="laboratories-title">Laboratories</h2>
    {setupRequired && <p role="status" className="laboratory-setup">Laboratory management needs a system update. Your existing inventory is available to view. Please contact an administrator.</p>}
    {error && <div role="alert" className="connection-error">{error}</div>}
    {success && <div role="status" className="success-message">{success}</div>}
    {action ? <form className="laboratory-form" aria-label={action.type === 'delete' ? 'Delete laboratory' : action.type === 'add' ? 'Add laboratory' : 'Edit laboratory'} onSubmit={save}>
      <h3>{action.type === 'delete' ? 'Delete laboratory' : action.type === 'add' ? 'Add laboratory' : 'Edit laboratory'}</h3>
      {action.type === 'delete' ? <>
        <p>Permanently delete <b>{name}</b>? This cannot be undone. Historical records remain.</p>
        {blockedDelete && <p role="status">This laboratory has {shelfCount(action.id)} shelf record(s). Delete its shelves before deleting the laboratory.</p>}
      </> : <>
        <label>Laboratory name<input aria-label="Laboratory name" required maxLength={120} autoFocus disabled={busy} value={name} onChange={event => setName(event.target.value)}/></label>
        <label>Description (optional)<textarea aria-label="Description (optional)" maxLength={1000} disabled={busy} value={description} onChange={event => setDescription(event.target.value)}/></label>
      </>}
      <div className="laboratory-buttons"><button type="submit" className={action.type === 'delete' ? 'delete-unit-button' : 'primary'} disabled={busy || setupRequired || blockedDelete}>{busy ? 'Saving…' : action.type === 'delete' ? 'Confirm delete laboratory' : 'Save laboratory'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setAction(null);setError('') }}>Cancel</button></div>
    </form> : <>
      <button type="button" className="primary laboratory-add" disabled={busy || setupRequired} onClick={() => open('add')}>Add laboratory</button>
      <div className="laboratory-list">{laboratories.map(lab => <article key={lab.id}>
        <div><h3>{lab.name}</h3>{lab.description && <p>{lab.description}</p>}{!setupRequired && <small>{shelfCount(lab.id)} {shelfCount(lab.id) === 1 ? 'shelf' : 'shelves'}</small>}</div>
        <div className="laboratory-buttons"><button type="button" className="secondary" aria-label={`Edit ${lab.name}`} disabled={busy || setupRequired} onClick={() => open('edit',lab)}>Edit</button><button type="button" className="delete-unit-button" aria-label={`Delete ${lab.name}`} disabled={busy || setupRequired} onClick={() => open('delete',lab)}>Delete</button></div>
      </article>)}</div>
      {!laboratories.length && <p>No laboratories yet. Add your first laboratory to start organizing inventory.</p>}
    </>}
  </div></div>
}

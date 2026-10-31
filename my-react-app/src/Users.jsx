import { useEffect, useState } from 'react'
import { fetchUsers, supabase } from './lib/supabase'
import { filterUsers, laboratoryRoles, loadUserLaboratories } from './lib/userLaboratories'
import './Users.css'

export default function Users({ laboratories, laboratorySetupRequired, onAccountChange, currentUser }) {
  const [users, setUsers] = useState([]), [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const [setupRequired, setSetupRequired] = useState(false)
  const [query, setQuery] = useState(''), [role, setRole] = useState('All'), [laboratory, setLaboratory] = useState('')
  const [editing, setEditing] = useState(null), [systemRole, setSystemRole] = useState('Operator'), [draft, setDraft] = useState([])
  const [busy, setBusy] = useState(false), [saveError, setSaveError] = useState('')
  const [reload, setReload] = useState(0)
  const [deleting, setDeleting] = useState(null), [confirmationEmail, setConfirmationEmail] = useState(''), [deleteError, setDeleteError] = useState('')
  useEffect(() => {
    let active = true
    Promise.all([fetchUsers(), supabase ? loadUserLaboratories(supabase) : Promise.resolve({ data: [], setupRequired: true })])
      .then(([accounts, memberships]) => {
        if (!active) return
        if (accounts.error || memberships.error) throw accounts.error || memberships.error
        setUsers(accounts.data || []); setAssignments(memberships.data || []); setSetupRequired(Boolean(memberships.setupRequired))
      }).catch(failure => { if (active) setError(failure.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reload])
  useEffect(() => {
    if (!editing && !deleting) return
    const escape = event => { if (event.key === 'Escape' && !busy) { setEditing(null); setDeleting(null) } }
    document.addEventListener('keydown', escape)
    const previous = document.activeElement
    const dialog = document.getElementById(deleting ? 'user-delete-dialog' : 'user-assignment-dialog')
    dialog?.querySelector('select,input,button')?.focus()
    const trap = event => {
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')]
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', escape); dialog?.removeEventListener('keydown', trap); previous?.focus() }
  }, [editing, deleting, busy])
  const activeAdmins = users.filter(user => user.role === 'Admin' && user.status === 'active').length
  const deletionBlocked = user => user.id === currentUser?.id ? 'You cannot delete your own signed-in account.'
    : user.role === 'Admin' && user.status === 'active' && activeAdmins <= 1 ? 'Keep at least one active System Admin.' : ''
  const visible = filterUsers(users, assignments, query, role, laboratory)
  const shownAssignments = systemRole === 'Admin'
    ? assignments.filter(row => row.user_id === editing?.id).map(({ laboratory_id, role }) => ({ laboratory_id, role }))
    : draft
  const name = id => laboratories.find(lab => lab.id === id)?.name || 'Unavailable laboratory'
  function open(user) {
    setEditing(user); setSystemRole(user.role); setDraft(assignments.filter(row => row.user_id === user.id).map(({ laboratory_id, role }) => ({ laboratory_id, role })))
    setSaveError(''); setSuccess('')
  }
  function update(index, field, value) { setDraft(rows => rows.map((row, i) => i === index ? { ...row, [field]: value } : row)) }
  async function deleteAccount(event) {
    event.preventDefault()
    if (busy || !deleting || deletionBlocked(deleting) || confirmationEmail.trim().toLowerCase() !== deleting.email.toLowerCase()) return
    setBusy(true); setDeleteError('')
    try {
      const { error: failure } = await supabase.rpc('inventory_delete_user_account', { p_user_id: deleting.id, p_confirmation_email: confirmationEmail.trim() })
      if (failure) throw failure
      setUsers(rows => rows.filter(row => row.id !== deleting.id))
      setAssignments(rows => rows.filter(row => row.user_id !== deleting.id))
      setSuccess(`Account ${deleting.email} deleted.`); setDeleting(null)
      onAccountChange()
    } catch (failure) { setDeleteError(failure.code === 'PGRST202' ? 'Account deletion needs a system update. Apply account_deletion.sql in Supabase SQL Editor.' : failure.message) }
    finally { setBusy(false) }
  }
  async function save(event) {
    event.preventDefault()
    if (busy) return
    if (shownAssignments.some(row => !row.laboratory_id) || new Set(shownAssignments.map(row => row.laboratory_id)).size !== shownAssignments.length) { setSaveError('Choose a different laboratory for each assignment.'); return }
    setBusy(true); setSaveError('')
    try {
      const { error: failure } = await supabase.rpc('inventory_save_user_assignments', { p_user_id: editing.id, p_system_role: systemRole, p_assignments: shownAssignments })
      if (failure) throw failure
      setUsers(rows => rows.map(row => row.id === editing.id ? { ...row, role: systemRole } : row))
      setAssignments(rows => [...rows.filter(row => row.user_id !== editing.id), ...shownAssignments.map(row => ({ ...row, user_id: editing.id }))])
      setEditing(null); setSuccess('User roles and laboratory assignments saved.')
      onAccountChange()
    } catch (failure) { setSaveError(failure.code === 'PGRST202' ? 'User assignments need a system update. Please contact an administrator.' : failure.message) }
    finally { setBusy(false) }
  }
  return <section className="card page users-page">
    <div className="cardhead"><div><h2>Users</h2><p>Manage accounts and assign laboratory roles.</p></div><span className="badge">{visible.length} users</span></div>
    {(setupRequired || laboratorySetupRequired) && <p role="status" className="connection-error">Laboratory assignments need a system update. Existing accounts are available to view.</p>}
    {error && <div role="alert" className="connection-error">{error} <button type="button" className="secondary" onClick={() => { setLoading(true); setError(''); setReload(value => value + 1) }}>Retry</button></div>}
    {success && <p role="status" className="success-message">{success}</p>}
    <div className="users-filters">
      <label>Search users<input type="search" placeholder="Name or email" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <label>Role<select aria-label="Role" value={role} onChange={event => setRole(event.target.value)}>{['All', 'System Admin', ...laboratoryRoles, 'Unassigned'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Laboratory<select aria-label="Laboratory filter" value={laboratory} onChange={event => setLaboratory(event.target.value)}><option value="">All laboratories</option>{laboratories.map(lab => <option key={lab.id} value={lab.id}>{lab.name}</option>)}</select></label>
    </div>
    {loading ? <p role="status">Loading users…</p> : !error && <>
      {!visible.length ? <div className="empty">No users match these filters.</div> : <table><thead><tr><th>NAME</th><th>EMAIL</th><th>SYSTEM ROLE</th><th>LABORATORY / ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{visible.map(user => {
        const memberships = assignments.filter(row => row.user_id === user.id)
        return <tr key={user.id}><td><b>{user.full_name}</b></td><td>{user.email}</td><td>{user.role === 'Admin' ? <span className="badge">System Admin</span> : '—'}</td><td><div className="user-memberships">{user.role === 'Admin' ? <span>All laboratories</span> : memberships.length ? memberships.map(row => <div key={row.laboratory_id}><b>{name(row.laboratory_id)}</b><span>{row.role}</span></div>) : <span>Unassigned</span>}</div></td><td>{user.status}</td><td><div className="user-row-actions"><button type="button" className="secondary" disabled={busy || setupRequired || laboratorySetupRequired} onClick={() => open(user)} aria-label={`Manage assignments for ${user.full_name}`}>Manage roles</button><button type="button" className="user-delete-button" disabled={busy || !!deletionBlocked(user)} title={deletionBlocked(user) || undefined} aria-label={`Delete account for ${user.full_name}`} onClick={() => { setDeleting(user); setConfirmationEmail(''); setDeleteError(''); setSuccess('') }}>Delete account</button></div></td></tr>
      })}</tbody></table>}
    </>}
    {editing && <div className="modal-backdrop"><form id="user-assignment-dialog" className="user-assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="user-assignment-title" onSubmit={save}>
      <h2 id="user-assignment-title">Manage roles</h2><p>{editing.full_name} · {editing.email}</p>
      <label>System role<select aria-label="System role" value={systemRole} disabled={busy} onChange={event => { setSystemRole(event.target.value); setSaveError('') }}><option value="Operator">Laboratory member</option><option value="Admin">System Admin</option></select></label>
      <p className="assignment-help">{systemRole === 'Admin' ? 'System Admins can access all laboratories without assignments. Select Laboratory member to edit laboratory assignments.' : 'Assign laboratory responsibilities below.'}</p>
      <fieldset className="laboratory-assignment-fields" disabled={busy || systemRole === 'Admin'}>
      <legend>Laboratory assignments</legend>
      {!shownAssignments.length && <p>No laboratory assigned.</p>}
      <div className="assignment-list">{shownAssignments.map((row, index) => <div className="assignment-row" key={index}>
        <label>Laboratory<select aria-label="Assigned laboratory" required value={row.laboratory_id} disabled={busy} onChange={event => update(index, 'laboratory_id', event.target.value)}><option value="">Choose laboratory</option>{!laboratories.some(lab => lab.id === row.laboratory_id) && row.laboratory_id && <option value={row.laboratory_id}>Unavailable laboratory</option>}{laboratories.map(lab => <option key={lab.id} value={lab.id} disabled={shownAssignments.some((other, i) => i !== index && other.laboratory_id === lab.id)}>{lab.name}</option>)}</select></label>
        <label>Laboratory role<select aria-label="Laboratory role" value={row.role} disabled={busy} onChange={event => update(index, 'role', event.target.value)}>{laboratoryRoles.map(value => <option key={value}>{value}</option>)}</select></label>
        <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(rows => rows.filter((_, i) => i !== index))} aria-label={`Remove assignment ${index + 1}`}>Remove</button>
      </div>)}</div>
      <button type="button" className="secondary" disabled={busy || !laboratories.some(lab => !draft.some(row => row.laboratory_id === lab.id))} onClick={() => setDraft(rows => [...rows, { laboratory_id: laboratories.find(lab => !rows.some(row => row.laboratory_id === lab.id)).id, role: 'Laboratory Operator' }])}>Add laboratory assignment</button>
      </fieldset>
      {saveError && <p role="alert" className="connection-error">{saveError}</p>}
      <div className="user-assignment-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save assignments'}</button></div>
    </form></div>}
    {deleting && <div className="modal-backdrop"><form id="user-delete-dialog" className="user-assignment-dialog user-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="user-delete-title" onSubmit={deleteAccount}>
      <h2 id="user-delete-title">Delete account?</h2>
      <p><b>{deleting.full_name}</b> · {deleting.email}</p>
      <p>This permanently deletes the sign-in account and laboratory assignments. Inventory, loans, and audit history are preserved. This cannot be undone.</p>
      <label>Type {deleting.email} to confirm<input aria-label="Confirm account email" type="email" autoComplete="off" required disabled={busy} value={confirmationEmail} onChange={event => setConfirmationEmail(event.target.value)}/></label>
      {deleteError && <p role="alert" className="connection-error">{deleteError}</p>}
      <div className="user-assignment-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button><button type="submit" className="user-delete-button" disabled={busy || confirmationEmail.trim().toLowerCase() !== deleting.email.toLowerCase()}>{busy ? 'Deleting…' : 'Delete account permanently'}</button></div>
    </form></div>}
  </section>
}

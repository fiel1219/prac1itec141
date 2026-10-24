import { useEffect, useState } from 'react'
import { fetchUsers, supabase } from './lib/supabase'
import { filterUsers, laboratoryRoles, loadUserLaboratories } from './lib/userLaboratories'
import './Users.css'

export default function Users({ laboratories, laboratorySetupRequired, onAccountChange }) {
  const [users, setUsers] = useState([]), [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const [setupRequired, setSetupRequired] = useState(false)
  const [query, setQuery] = useState(''), [role, setRole] = useState('All'), [laboratory, setLaboratory] = useState('')
  const [editing, setEditing] = useState(null), [systemRole, setSystemRole] = useState('Operator'), [draft, setDraft] = useState([])
  const [busy, setBusy] = useState(false), [saveError, setSaveError] = useState('')
  const [reload, setReload] = useState(0)
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
    if (!editing) return
    const escape = event => { if (event.key === 'Escape' && !busy) setEditing(null) }
    document.addEventListener('keydown', escape)
    const previous = document.activeElement
    const dialog = document.getElementById('user-assignment-dialog')
    dialog?.querySelector('select,button')?.focus()
    const trap = event => {
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled)')]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', escape); dialog?.removeEventListener('keydown', trap); previous?.focus() }
  }, [editing, busy])
  const visible = filterUsers(users, assignments, query, role, laboratory)
  const name = id => laboratories.find(lab => lab.id === id)?.name || 'Unavailable laboratory'
  function open(user) {
    setEditing(user); setSystemRole(user.role); setDraft(assignments.filter(row => row.user_id === user.id).map(({ laboratory_id, role }) => ({ laboratory_id, role })))
    setSaveError(''); setSuccess('')
  }
  function update(index, field, value) { setDraft(rows => rows.map((row, i) => i === index ? { ...row, [field]: value } : row)) }
  async function save(event) {
    event.preventDefault()
    if (busy) return
    if (draft.some(row => !row.laboratory_id) || new Set(draft.map(row => row.laboratory_id)).size !== draft.length) { setSaveError('Choose a different laboratory for each assignment.'); return }
    setBusy(true); setSaveError('')
    try {
      const { error: failure } = await supabase.rpc('inventory_save_user_assignments', { p_user_id: editing.id, p_system_role: systemRole, p_assignments: draft })
      if (failure) throw failure
      setUsers(rows => rows.map(row => row.id === editing.id ? { ...row, role: systemRole } : row))
      setAssignments(rows => [...rows.filter(row => row.user_id !== editing.id), ...draft.map(row => ({ ...row, user_id: editing.id }))])
      setEditing(null); setSuccess('User roles and laboratory assignments saved.')
      onAccountChange()
    } catch (failure) { setSaveError(failure.code === 'PGRST202' ? 'User assignments need a system update. Please contact an administrator.' : failure.message) }
    finally { setBusy(false) }
  }
  return <section className="card page users-page">
    <div className="cardhead"><div><h2>Users</h2><p>Assign Laboratory Admins and Laboratory Operators to each laboratory.</p></div><span className="badge">{visible.length} users</span></div>
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
        return <tr key={user.id}><td><b>{user.full_name}</b></td><td>{user.email}</td><td>{user.role === 'Admin' ? <span className="badge">System Admin</span> : '—'}</td><td><div className="user-memberships">{memberships.length ? memberships.map(row => <div key={row.laboratory_id}><b>{name(row.laboratory_id)}</b><span>{row.role}</span></div>) : <span>{user.role === 'Admin' ? 'All laboratories (system administration)' : 'Unassigned'}</span>}</div></td><td>{user.status}</td><td><button type="button" className="secondary" disabled={setupRequired || laboratorySetupRequired} onClick={() => open(user)} aria-label={`Manage assignments for ${user.full_name}`}>Manage roles</button></td></tr>
      })}</tbody></table>}
    </>}
    {editing && <div className="modal-backdrop"><form id="user-assignment-dialog" className="user-assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="user-assignment-title" onSubmit={save}>
      <h2 id="user-assignment-title">Manage roles</h2><p>{editing.full_name} · {editing.email}</p>
      <label>System role<select aria-label="System role" value={systemRole} disabled={busy} onChange={event => setSystemRole(event.target.value)}><option value="Operator">Laboratory member</option><option value="Admin">System Admin</option></select></label>
      <p className="assignment-help">System Admins manage users across all laboratories. Assign laboratory responsibilities below.</p>
      <h3>Laboratory assignments</h3>
      {!draft.length && <p>No laboratory assigned.</p>}
      <div className="assignment-list">{draft.map((row, index) => <div className="assignment-row" key={index}>
        <label>Laboratory<select aria-label="Assigned laboratory" required value={row.laboratory_id} disabled={busy} onChange={event => update(index, 'laboratory_id', event.target.value)}><option value="">Choose laboratory</option>{!laboratories.some(lab => lab.id === row.laboratory_id) && row.laboratory_id && <option value={row.laboratory_id}>Unavailable laboratory</option>}{laboratories.map(lab => <option key={lab.id} value={lab.id} disabled={draft.some((other, i) => i !== index && other.laboratory_id === lab.id)}>{lab.name}</option>)}</select></label>
        <label>Laboratory role<select aria-label="Laboratory role" value={row.role} disabled={busy} onChange={event => update(index, 'role', event.target.value)}>{laboratoryRoles.map(value => <option key={value}>{value}</option>)}</select></label>
        <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(rows => rows.filter((_, i) => i !== index))} aria-label={`Remove assignment ${index + 1}`}>Remove</button>
      </div>)}</div>
      <button type="button" className="secondary" disabled={busy || !laboratories.some(lab => !draft.some(row => row.laboratory_id === lab.id))} onClick={() => setDraft(rows => [...rows, { laboratory_id: laboratories.find(lab => !rows.some(row => row.laboratory_id === lab.id)).id, role: 'Laboratory Operator' }])}>Add laboratory assignment</button>
      {saveError && <p role="alert" className="connection-error">{saveError}</p>}
      <div className="user-assignment-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save assignments'}</button></div>
    </form></div>}
  </section>
}

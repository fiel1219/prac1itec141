import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { fetchShelves, fetchBorrowers, fetchTransactions, fetchUsers, fetchApprovals, isSupabaseConfigured, supabase } from './lib/supabase'
import { InventoryLabels, InventoryScanner } from './InventoryQR'
import { ItemManagement, StockMovements, Reports, LowStockAlerts } from './InventoryFeatures'
import { activeUnits, availableUnits as getAvailableUnits } from './lib/inventory'

const nav = ['Dashboard','Scan QR','Shelves','Items','Stock Movements','Borrowers','Returns','Transaction History','Inventory Checks','Reports']
const admin = ['Users','Admin Approvals','Permissions','Activity Logs','Settings']
const Badge = ({children,tone=''}) => <span className={'badge '+tone}>{children}</span>

export default function App() {
  const [page,setPage] = useState('Dashboard')
  const [mobile,setMobile] = useState(false)
  const [query,setQuery] = useState('')
  const [dbShelves,setDbShelves] = useState([])
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [currentUser,setCurrentUser] = useState(null)
  const [userMenu,setUserMenu] = useState(false)
  const [selectedShelf,setSelectedShelf] = useState(null)
  const [migrationRequired,setMigrationRequired] = useState(false)
  async function refreshInventory() {
    const { data, error: failure, migrationRequired: needsMigration } = await fetchShelves()
    if (failure) setError(failure.message)
    else { setDbShelves(data || []); setMigrationRequired(Boolean(needsMigration)); setError('') }
    setLoading(false)
  }
  useEffect(() => {
    Promise.resolve().then(refreshInventory)
    const timer = setInterval(refreshInventory, 30000)
    const refresh = () => { if (document.visibilityState === 'visible') refreshInventory() }
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => { supabase?.auth.getUser().then(async ({ data }) => { if (!data.user) return; const { data: account } = await supabase.from('user_accounts').select('full_name,email,role').eq('email', data.user.email).maybeSingle(); setCurrentUser(account || { full_name: data.user.user_metadata?.full_name || 'User', email: data.user.email, role: 'Operator' }) }) }, [])
  const shelves = useMemo(() => dbShelves.filter(s => (s.code+' '+s.name+' '+s.item_type).toLowerCase().includes(query.toLowerCase())), [dbShelves,query])
  const units = dbShelves.flatMap(activeUnits)
  const count = status => units.filter(u => u.status === status).length
  const go = name => { setPage(name); setMobile(false) }
  return <div className="app"><MainBrand currentUser={currentUser} />
    <aside className={mobile ? 'side open' : 'side'}><div className="brand"><b>⌁</b><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div><div className="sidebar-user"><div className="user-avatar">{(currentUser?.full_name || 'U').charAt(0).toUpperCase()}</div><div><b>{currentUser?.full_name || 'Loading user...'}</b><small>{currentUser?.email || ''}</small><span>{currentUser?.role || 'Operator'}</span></div><button className="user-menu-toggle" onClick={()=>setUserMenu(!userMenu)} aria-label="Open user menu">⌄</button>{userMenu&&<button className="logout user-menu-logout" onClick={()=>supabase?.auth.signOut()}>Log out</button>}</div><div className="workspace">● Science Laboratory　⌄</div><label>MAIN MENU</label><nav>{nav.map((n,i)=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>{['⌂','▤','▥','▦','↕','♙','↔','✓','▥','▧'][i]} {n}</button>)}</nav>{currentUser?.role === 'Admin' && <><label>ADMINISTRATION</label><nav>{admin.map(n=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>⚙ {n}</button>)}</nav></>}</aside>
    <main><header><button className="mobile" onClick={()=>setMobile(!mobile)}>☰</button><div><label>SUPABASE DATABASE</label><h1>{page}</h1><p>{isSupabaseConfigured?'Live data connection':'Environment variables are missing'}</p></div><div className="head"><span>{isSupabaseConfigured?'Connected':'Not connected'}</span><button className="logout" onClick={()=>supabase?.auth.signOut()}>Log out</button></div></header>
    {error && <div className="connection-error"><b>Database connection error:</b> {error}</div>}
    {migrationRequired && <section className="card inventory-alerts" role="status"><h2>Inventory update needs database setup</h2><p>Your inventory is available to view. To enable item management, stock movements, reports, and checkout/returns, run <code>supabase/inventoscan_features.sql</code> followed by <code>supabase/inventory_qr.sql</code> in your Supabase SQL Editor, then refresh this page.</p></section>}
    {page==='Dashboard' && <section className="stats">{[['Total units',units.length,'From Supabase','▤'],['Available',dbShelves.reduce((total, shelf) => total + getAvailableUnits(shelf).length, 0),'Live inventory count','✓'],['Borrowed',count('borrowed'),'Live inventory count','↗'],['Needs attention',units.filter(u=>u.status==='under_maintenance'||u.condition==='damaged').length,'Damaged or maintenance','!']].map((x,i)=><div className="stat" key={x[0]}><i className={'c'+i}>{x[3]}</i><small>{x[0]}</small><strong>{loading?'…':x[1]}</strong><em>{x[2]}</em></div>)}</section>}
    {page==='Dashboard' && !loading && !error && !migrationRequired && <LowStockAlerts shelves={dbShelves}/>}
    {page==='Items' && !migrationRequired && <ItemManagement shelves={dbShelves} onChange={refreshInventory} onQR={setSelectedShelf} onUnitQR={(shelf, unit) => setSelectedShelf({ ...shelf, qrUnit: unit })}/>}
    {page==='Stock Movements' && !migrationRequired && <StockMovements shelves={dbShelves} onChange={refreshInventory}/>}
    {page==='Reports' && !loading && !error && !migrationRequired && <Reports shelves={dbShelves}/>}
    {page==='Scan QR' && <InventoryScanner onChange={refreshInventory} migrationRequired={migrationRequired}/>}
    {(page==='Dashboard'||page==='Shelves'||page==='Inventory') && <section className="card page"><div className="cardhead"><div><h2>{page==='Dashboard'?'Shelves from Supabase':page}</h2><p>{loading?'Loading database records…':shelves.length+' shelf records loaded from Supabase'}</p></div><Badge tone={error?'bad':''}>{loading?'Loading':error?'Error':'Connected'}</Badge></div>{page!=='Dashboard'&&<div className="search">⌕ <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search shelves..."/></div>}{!loading&&!error&&!shelves.length&&<div className="empty">No shelves found. Run seed.sql in Supabase, then refresh.</div>}<div className="shelves">{shelves.map(s=><article className="shelf" key={s.id} onClick={()=>setSelectedShelf(s)}><div><i>▥</i><Badge>{getAvailableUnits(s).length} available</Badge></div><h2>{s.name}</h2><p>{s.code} · {s.item_type}</p><hr/><small><b>{activeUnits(s).length}</b> total units <span>{activeUnits(s).filter(u=>u.status==='borrowed').length} borrowed</span></small></article>)}</div></section>}
    {selectedShelf && <InventoryLabels key={selectedShelf.id + (selectedShelf.qrUnit?.id || '')} shelf={selectedShelf} close={()=>setSelectedShelf(null)} />}
    {!['Dashboard','Scan QR','Shelves','Inventory','Items','Stock Movements','Reports'].includes(page)&&<DatabaseTable key={page} page={page} onChange={refreshInventory} migrationRequired={migrationRequired}/>}
    </main></div>
}

function MainBrand() {
  return <div className="main-brand-user"><div className="brand"><b>⌁</b><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div></div>
}

function DatabaseTable({ page, onChange, migrationRequired }) {
  const [returnBusy, setReturnBusy] = useState(false)
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [roleFilter, setRoleFilter] = useState('All')
  const [transactionFilter, setTransactionFilter] = useState('all')
  const [returning, setReturning] = useState(null), [returnCondition, setReturnCondition] = useState('good')
  useEffect(() => { const load = page === 'Borrowers' ? fetchBorrowers() : page === 'Returns' || page === 'Transaction History' ? fetchTransactions() : page === 'Users' ? fetchUsers() : page === 'Admin Approvals' ? fetchApprovals() : Promise.resolve({ data: [] }); load.then(({ data, error }) => { if (error) setError(error.message); else setRows(data || []); setLoading(false) }) }, [page])
  const isBorrowers = page === 'Borrowers', isReturns = page === 'Returns', isHistory = page === 'Transaction History', isAdmins = page === 'Admins', isUsers = page === 'Users', isApprovals = page === 'Admin Approvals'
  const activeReturns = rows.filter(r => !r.returned_at)
  async function returnItem(row) { setReturning(row); setReturnCondition('good') }
  async function confirmReturn() {
    if (migrationRequired) { setError('Complete the database setup shown above before returning items.'); return }
    if (!returning || returnBusy) return
    setReturnBusy(true); setError('')
    try {
      const { error: failure } = await supabase.rpc('inventory_return', { p_transaction_id: returning.id, p_condition: returnCondition })
      if (failure) throw failure
      setRows(previous => previous.filter(item => item.id !== returning.id)); setReturning(null)
      await onChange()
    } catch (failure) { setError(failure.message) } finally { setReturnBusy(false) }
  }
  const returnModal = returning && <div className="modal-backdrop"><div className="return-modal"><div className="return-modal-icon">↩</div><span className="eyebrow">PROCESS RETURN</span><h2>Return item</h2><p>Confirm the condition of <b>{returning.inventory_units?.shelves?.code || 'the item'} #{String(returning.inventory_units?.unit_number || '').padStart(3,'0')}</b> returned by <b>{returning.borrowers?.name || 'the borrower'}</b>.</p><label>Return condition<select disabled={returnBusy} value={returnCondition} onChange={e=>setReturnCondition(e.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label>{error && <div role="alert" className="connection-error">{error}</div>}<div className="return-modal-actions"><button className="secondary" onClick={()=>setReturning(null)} disabled={returnBusy}>Cancel</button><button className="primary" onClick={confirmReturn} disabled={returnBusy}>Confirm return</button></div></div></div>
  const visibleUsers = rows.filter(r => roleFilter === 'All' || r.role === roleFilter)
  async function changeRole(user, role) { const { error: x } = await supabase.from('user_accounts').update({ role }).eq('id', user.id); if (x) setError(x.message); else setRows(rows.map(r => r.id === user.id ? { ...r, role } : r)) }
  if (isUsers) return <section className="card page"><div className="cardhead"><div><h2>Users</h2><p>Manage Admin and Operator accounts</p></div><Badge>{visibleUsers.length} users</Badge></div><div className="toolbar"><div className="search"><input placeholder="Search users..." onChange={e => setRows(rows.filter(r => r.full_name.toLowerCase().includes(e.target.value.toLowerCase()) || r.email.toLowerCase().includes(e.target.value.toLowerCase())))} /></div><select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option>All</option><option>Admin</option><option>Operator</option></select></div><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>CHANGE ROLE</th></tr></thead><tbody>{visibleUsers.map(r => <tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td><Badge>{r.role}</Badge></td><td>{r.status}</td><td><select value={r.role} onChange={e => changeRole(r,e.target.value)}><option>Admin</option><option>Operator</option></select></td></tr>)}</tbody></table></section>
  async function approve(row, requestedRole) { const added = await supabase.from('user_accounts').insert({ full_name: row.full_name, email: row.email, role: requestedRole, status: 'active' }); if (added.error) { setError(added.error.message); return } const changed = await supabase.from('account_approvals').update({ status: 'approved', requested_role: requestedRole, reviewed_by: 'Current Admin', reviewed_at: new Date().toISOString() }).eq('id', row.id); if (changed.error) setError(changed.error.message); else setRows(rows.filter(item => item.id !== row.id)) }
  if (isHistory) { const filteredTransactions = rows.filter(r => transactionFilter === 'all' || (transactionFilter === 'returned' ? Boolean(r.returned_at) : !r.returned_at)); return <section className="card page"><div className="cardhead"><div><h2>Transaction History</h2><p>All checkout and return records.</p></div><div className="history-controls"><select value={transactionFilter} onChange={e=>setTransactionFilter(e.target.value)}><option value="all">All items</option><option value="borrowed">Borrowed</option><option value="returned">Returned</option></select><Badge>{filteredTransactions.length} records</Badge></div></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && !filteredTransactions.length && <div className="empty">No transactions match this filter.</div>}{filteredTransactions.length > 0 && <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>BORROWED BY</th><th>RETURNED BY</th><th>STATUS</th></tr></thead><tbody>{filteredTransactions.map(r=><tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.inventory_units?.shelves?.code || '—'} #{String(r.inventory_units?.unit_number || '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td>{r.borrowed_by || '—'}</td><td>{r.returned_by || '—'}</td><td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td></tr>)}</tbody></table>}</section> }
  if (isReturns) return <section className="card page"><div className="cardhead"><div><h2>Returns</h2><p>Process borrowed items returned to the laboratory.</p></div><Badge>{activeReturns.length} active</Badge></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && !activeReturns.length && <div className="empty">No borrowed items are waiting to be returned.</div>}{activeReturns.length > 0 && <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>ACTION</th></tr></thead><tbody>{activeReturns.map(r => <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.inventory_units?.shelves?.code || '—'} #{String(r.inventory_units?.unit_number || '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><button className="primary" onClick={() => returnItem(r)}>Mark returned</button></td></tr>)}</tbody></table>}{returnModal}</section>
  if (isApprovals) return <section className="card page"><div className="cardhead"><div><h2>Admin Approvals</h2><p>Choose a role before approving each account</p></div><Badge>{rows.length} requests</Badge></div>{error&&<div className="connection-error">{error}</div>}<table><thead><tr><th>NAME</th><th>EMAIL</th><th>ASSIGN ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td>{r.status==='pending'?<select value={r.requested_role || 'Operator'} onChange={e=>setRows(rows.map(x=>x.id===r.id?{...x,requested_role:e.target.value}:x))}><option>Admin</option><option>Operator</option></select>:r.requested_role}</td><td><Badge tone={r.status==='pending'?'':'neutral'}>{r.status}</Badge></td><td>{r.status==='pending'&&<button className="primary" onClick={()=>approve(r,r.requested_role || 'Operator')}>Approve</button>}</td></tr>)}</tbody></table></section>
  return <section className="card page"><div className="cardhead"><div><h2>{page}</h2><p>Live records loaded from Supabase</p></div><Badge tone={error ? 'bad' : ''}>{loading ? 'Loading' : error ? 'Error' : rows.length + ' records'}</Badge></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && rows.length === 0 && <div className="empty">No records found in the {page.toLowerCase()} table.</div>}{rows.length > 0 && <table><thead><tr>{(isBorrowers ? ['Name','Student / Employee ID','Created'] : isAdmins ? ['Full name','Email','Status','Created'] : ['Reference','Borrower','Item','Borrowed','Expected return','Returned']).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(r => isBorrowers ? <tr key={r.id}><td><b>{r.name}</b></td><td>{r.identity_number}</td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : isAdmins ? <tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td><Badge tone={r.status === 'disabled' ? 'bad' : ''}>{r.status}</Badge></td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.inventory_units?.shelves?.code || '—'} #{String(r.inventory_units?.unit_number || '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td></tr>)}</tbody></table>}</section>
}

import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { fetchShelves, fetchLaboratories, fetchBorrowers, fetchTransactions, fetchApprovals, isSupabaseConfigured, supabase } from './lib/supabase'
import { InventoryLabels, InventoryScanner } from './InventoryQR'
import { AddShelfDialog, ItemManagement, StockMovements, Reports } from './InventoryFeatures'
import { activeUnits, shelfItems, stockQuantity, availableQuantity, inventoryCategoryTotals } from './lib/inventory'
import { LaboratorySelector, LaboratoryManager } from './Laboratories'
import { storedLaboratory, rememberLaboratory } from './lib/laboratories'
import Users from './Users'
import { loadUserLaboratories, userRoleLabel } from './lib/userLaboratories'

const nav = ['Dashboard','Scan QR','Shelves','Items','Returns','Transaction History','Inventory Checks','Reports']
const admin = ['Users','Admin Approvals']
const Badge = ({children,tone=''}) => <span className={'badge '+tone}>{children}</span>

export default function App() {
  const [page,setPage] = useState('Dashboard')
  const [mobile,setMobile] = useState(false)
  const [query,setQuery] = useState('')
  const [allShelves,setAllShelves] = useState([])
  const [laboratories,setLaboratories] = useState([]), [laboratoryId,setLaboratoryId] = useState(storedLaboratory)
  const laboratorySelection = useRef(laboratoryId)
  const [laboratorySetupRequired,setLaboratorySetupRequired] = useState(false), [managingLaboratories,setManagingLaboratories] = useState(false)
  const refreshVersion = useRef(0)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [currentUser,setCurrentUser] = useState(null)
  const [userAssignments,setUserAssignments] = useState([]), [accountVersion,setAccountVersion] = useState(0)
  const [assignmentError,setAssignmentError] = useState('')
  const [selectedShelf,setSelectedShelf] = useState(null)
  const [addingShelf,setAddingShelf] = useState(false)
  const [migrationRequired,setMigrationRequired] = useState(false)
  const [unitActionsRequired,setUnitActionsRequired] = useState(true)
  const [permanentDeleteRequired,setPermanentDeleteRequired] = useState(true)
  const [itemNamesRequired,setItemNamesRequired] = useState(true)
  const [itemCategoriesRequired,setItemCategoriesRequired] = useState(true)
  async function refreshInventory(preferredLaboratoryId) {
    const version = ++refreshVersion.current
    try {
      const [inventory,labs] = await Promise.all([fetchShelves(),fetchLaboratories()])
      if (version !== refreshVersion.current) return false
      if (inventory.error || labs.error) throw inventory.error || labs.error
      setAllShelves(inventory.data || []);setLaboratories(labs.data || []);setLaboratorySetupRequired(Boolean(labs.setupRequired))
      const preferred = typeof preferredLaboratoryId === 'string' ? preferredLaboratoryId : laboratorySelection.current
      const next = labs.data.some(lab => lab.id === preferred) ? preferred : labs.data[0]?.id || ''
      if (next !== laboratorySelection.current) selectLaboratory(next)
      setMigrationRequired(Boolean(inventory.migrationRequired));setUnitActionsRequired(Boolean(inventory.unitActionsRequired))
      setPermanentDeleteRequired(Boolean(inventory.permanentDeleteRequired));setItemNamesRequired(Boolean(inventory.itemNamesRequired))
      setItemCategoriesRequired(Boolean(inventory.itemCategoriesRequired));setError('')
      return true
    } catch (failure) { if (version === refreshVersion.current) setError(failure.message);return false }
    finally { if (version === refreshVersion.current) setLoading(false) }
  }
  function selectLaboratory(id) {
    laboratorySelection.current=id;setLaboratoryId(id);setQuery('');setSelectedShelf(null);setAddingShelf(false);setMobile(false)
  }
  useEffect(() => { rememberLaboratory(laboratoryId) }, [laboratoryId])
  useEffect(() => {
    Promise.resolve().then(refreshInventory)
    const timer = setInterval(refreshInventory, 30000)
    const refresh = () => { if (document.visibilityState === 'visible') refreshInventory() }
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => {
    let active = true
    supabase?.auth.getUser().then(async ({ data }) => {
      if (!data.user) return
      const { data: account, error: accountError } = await supabase.from('user_accounts').select('id,full_name,email,role').eq('email', data.user.email).maybeSingle()
      if (!active) return
      if (accountError) { setAssignmentError(accountError.message); return }
      setCurrentUser(account || { full_name: data.user.user_metadata?.full_name || 'User', email: data.user.email, role: 'Operator' })
      if (account?.role !== 'Admin') setPage(previous => admin.includes(previous) ? 'Dashboard' : previous)
      if (account?.id) {
        const result = await loadUserLaboratories(supabase, account.id)
        if (!active) return
        setUserAssignments(result.data || []); setAssignmentError(result.error?.message || '')
      }
    }).catch(failure => { if (active) setAssignmentError(failure.message) })
    return () => { active = false }
  }, [accountVersion])
  const selectedLaboratory = laboratories.find(lab => lab.id === laboratoryId)
  const scopedLaboratoryId = laboratorySetupRequired ? null : selectedLaboratory?.id || null
  const dbShelves = useMemo(() => laboratorySetupRequired ? allShelves : allShelves.filter(shelf => shelf.laboratory_id === laboratoryId), [allShelves,laboratoryId,laboratorySetupRequired])
  const canManageInventory = laboratorySetupRequired || !!selectedLaboratory
  const shelves = useMemo(() => dbShelves.filter(s => (s.code+' '+s.name+' '+shelfItems(s).map(item => item.name).join(' ')).toLowerCase().includes(query.toLowerCase())), [dbShelves,query])
  const inventoryTotals = dbShelves.reduce((totals,shelf) => {
    const shelfTotals = inventoryCategoryTotals(shelf)
    totals.equipment += shelfTotals.equipment
    totals.consumables += shelfTotals.consumables
    return totals
  }, { equipment:0, consumables:0 })
  const go = name => { setPage(name); setMobile(false) }
  const compactPage = ['Shelves','Returns','Transaction History','Inventory Checks','Reports'].includes(page)
  const hidePageHeader = compactPage || page === 'Items'
  return <div className="app"><MainBrand currentUser={currentUser} />
    <aside className={mobile ? 'side open' : 'side'}><div className="brand"><b>⌁</b><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div><div className="sidebar-user"><div className="user-avatar">{(currentUser?.full_name || 'U').charAt(0).toUpperCase()}</div><div><b>{currentUser?.full_name || 'Loading user...'}</b><small>{currentUser?.email || ''}</small><span>{currentUser ? userRoleLabel(currentUser,userAssignments,laboratoryId) : 'Loading role…'}{currentUser?.role !== 'Admin' && userAssignments.some(row=>row.user_id===currentUser?.id && row.laboratory_id===laboratoryId) && selectedLaboratory && ` · ${selectedLaboratory.name}`}</span></div></div><div className="sidebar-navigation"><LaboratorySelector laboratories={laboratories} selectedId={laboratoryId} loading={loading} onManage={()=>setManagingLaboratories(true)} onSelect={selectLaboratory}/><label>MAIN MENU</label><nav>{nav.map((n,i)=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>{['⌂','▤','▥','▦','↔','✓','▥','▧'][i]} {n==='Items' ? 'Equipment and Consumables' : n}</button>)}</nav>{currentUser?.role === 'Admin' && <><label>ADMINISTRATION</label><nav>{admin.map(n=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>⚙ {n}</button>)}</nav></>}</div><nav className="sidebar-footer" aria-label="Account"><button type="button" onClick={()=>supabase?.auth.signOut()}><span aria-hidden="true">↪</span> Log out</button></nav></aside>
    {managingLaboratories && <LaboratoryManager laboratories={laboratories} shelves={allShelves} setupRequired={laboratorySetupRequired} onClose={()=>setManagingLaboratories(false)} onChange={async preferredId=>{if(!await refreshInventory(preferredId))throw new Error('Changes were saved, but inventory could not be refreshed. Refresh the page.')}}/>}
    <main key={laboratoryId || 'no-laboratory'} className={compactPage ? 'compact-page' : undefined}><header className={hidePageHeader ? 'inventory-page-header' : undefined}><button className="mobile" onClick={()=>setMobile(!mobile)}>☰</button>{!hidePageHeader && <div><h1>{page}</h1><p>{isSupabaseConfigured ? selectedLaboratory?.name || 'Laboratory inventory' : 'Connection setup required'}</p></div>}{!hidePageHeader && <div className="head"><span>{isSupabaseConfigured?'Connected':'Not connected'}</span></div>}</header>
    {assignmentError && <div role="alert" className="connection-error">Could not load account assignments: {assignmentError}</div>}
    {error && <div className="connection-error"><b>Database connection error:</b> {error}</div>}
    {!loading && !error && !canManageInventory && ['Dashboard','Shelves','Inventory','Items','Scan QR','Stock Movements','Reports','Returns','Transaction History','Inventory Checks'].includes(page) && <section className="card page"><h2>No laboratories yet</h2><p>Add a laboratory to start organizing shelves and inventory.</p><button type="button" className="primary" onClick={()=>setManagingLaboratories(true)}>Add laboratory</button></section>}

    {migrationRequired && <section className="card inventory-alerts" role="status"><h2>Inventory setup required</h2><p>You can view inventory. Ask an administrator to complete setup before managing stock, reports, and equipment loans.</p></section>}
    {!migrationRequired && unitActionsRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Equipment management update required</h2><p>Ask an administrator to update equipment management before moving or deleting equipment.</p></section>}
    {!migrationRequired && permanentDeleteRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Deletion update required</h2><p>Ask an administrator to enable permanent deletion for shelves and items.</p></section>}
    {!migrationRequired && itemNamesRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Item management update required</h2><p>Ask an administrator to update item management before adding named items or issuing stock by item.</p></section>}
    {!migrationRequired && !itemNamesRequired && itemCategoriesRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Consumable stock update required</h2><p>Ask an administrator to update consumable stock tracking before adding or issuing quantities.</p></section>}
    {page==='Dashboard' && <section className="stats">{[['Shelves',dbShelves.length,'Total shelves','▥'],['Equipments',inventoryTotals.equipment,'Total equipment','▤'],['Consumables',inventoryTotals.consumables,'Total quantity','▦']].map((x,i)=><div className="stat" key={x[0]}><i className={'c'+i}>{x[3]}</i><small>{x[0]}</small><strong>{loading?'…':x[1]}</strong><em>{x[2]}</em></div>)}</section>}
    {page==='Users' && currentUser?.role==='Admin' && <Users laboratories={laboratories} laboratorySetupRequired={laboratorySetupRequired} onAccountChange={()=>setAccountVersion(value=>value+1)}/>}
    {page==='Items' && canManageInventory && !migrationRequired && <ItemManagement shelves={dbShelves} onChange={refreshInventory} onQR={setSelectedShelf} onUnitQR={(shelf, unit) => setSelectedShelf({ ...shelf, qrUnit: unit })}/>}
    {page==='Stock Movements' && canManageInventory && !migrationRequired && <StockMovements laboratoryId={scopedLaboratoryId} shelves={dbShelves} onChange={refreshInventory} itemNamesRequired={itemNamesRequired} itemCategoriesRequired={itemCategoriesRequired}/>}
    {page==='Reports' && canManageInventory && !loading && !error && !migrationRequired && <Reports shelves={dbShelves}/>}
    {page==='Scan QR' && canManageInventory && <InventoryScanner laboratoryId={scopedLaboratoryId} onChange={refreshInventory} migrationRequired={migrationRequired} itemNamesRequired={itemNamesRequired} itemCategoriesRequired={itemCategoriesRequired}/>}
    {canManageInventory && (page==='Dashboard'||page==='Shelves'||page==='Inventory') && <section className="card page">
      <div className="cardhead"><div><h2>{page==='Dashboard'?'Shelves':page}</h2><p>{loading?'Loading shelves…':`${shelves.length} ${shelves.length === 1 ? 'shelf' : 'shelves'}`}</p></div>
        <div className="shelf-page-actions"><button type="button" className="primary shelf-add-button" disabled={loading || Boolean(error) || migrationRequired} onClick={()=>setAddingShelf(true)}>Add shelf</button><Badge tone={error?'bad':''}>{loading?'Loading':error?'Error':'Connected'}</Badge></div>
      </div>
      {page!=='Dashboard' && <div className="search">⌕ <input aria-label="Search shelves" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search shelves..."/></div>}
      {!loading && !error && !shelves.length && <div className="empty shelf-empty-state">{dbShelves.length ? <><p>No shelves match your search.</p><button type="button" className="secondary" onClick={()=>setQuery('')}>Clear search</button></> : <><p>No shelves yet. Add your first shelf to start managing inventory.</p><button type="button" className="primary" disabled={migrationRequired} onClick={()=>setAddingShelf(true)}>Add your first shelf</button></>}</div>}
      <div className="shelves">{shelves.map(s=>{
        const totals = inventoryCategoryTotals(s)
        return <article className="shelf" key={s.id} onClick={()=>setSelectedShelf(s)}><div><i>▥</i><Badge>{availableQuantity(s)} available</Badge></div><h2>{s.name}</h2><p>{s.code}</p>{s.description && <p className="item-description">{s.description}</p>}<hr/>
          <div className="shelf-category-totals"><small><b>{totals.equipment}</b> total equipment</small><small><b>{totals.consumables}</b> total consumables</small></div>
          <small className="shelf-stock-total"><b>{stockQuantity(s)}</b> total quantity <span>{activeUnits(s).filter(u=>u.status==='borrowed').length} borrowed</span></small>
        </article>
      })}</div>
    </section>}
    {addingShelf && canManageInventory && <AddShelfDialog laboratoryId={scopedLaboratoryId} onClose={()=>setAddingShelf(false)} onSaved={async()=>{ setQuery(''); await refreshInventory(); setAddingShelf(false) }}/>}
    {selectedShelf && dbShelves.some(shelf=>shelf.id===selectedShelf.id) && <InventoryLabels key={selectedShelf.id + (selectedShelf.qrUnit?.id || (selectedShelf.qrConsumables ? 'consumables' : ''))} shelf={{ ...(dbShelves.find(shelf => shelf.id === selectedShelf.id) || selectedShelf), qrUnit: selectedShelf.qrUnit, qrConsumables:selectedShelf.qrConsumables }} shelves={dbShelves} close={()=>setSelectedShelf(null)} onChange={refreshInventory} migrationRequired={migrationRequired} unitActionsRequired={unitActionsRequired} permanentDeleteRequired={permanentDeleteRequired} itemNamesRequired={itemNamesRequired} itemCategoriesRequired={itemCategoriesRequired} />}
    {(canManageInventory || !['Returns','Transaction History','Inventory Checks'].includes(page)) && !['Dashboard','Scan QR','Shelves','Inventory','Items','Stock Movements','Reports','Users'].includes(page)&&<DatabaseTable key={`${page}:${laboratoryId}`} laboratoryId={scopedLaboratoryId} page={page} onChange={refreshInventory} migrationRequired={migrationRequired} shelves={dbShelves} onOpenShelf={setSelectedShelf}/>}
    </main></div>
}

function MainBrand() {
  return <div className="main-brand-user"><div className="brand"><b>⌁</b><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div></div>
}

function DatabaseTable({ page, onChange, migrationRequired, shelves = [], onOpenShelf, laboratoryId }) {
  const [returnBusy, setReturnBusy] = useState(false)
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [transactionFilter, setTransactionFilter] = useState('all')
  const [returning, setReturning] = useState(null), [returnCondition, setReturnCondition] = useState('good')
  useEffect(() => { const load = page === 'Borrowers' ? fetchBorrowers() : page === 'Returns' || page === 'Transaction History' ? fetchTransactions(page === 'Returns',laboratoryId) : page === 'Admin Approvals' ? fetchApprovals() : Promise.resolve({ data: [] }); load.then(({ data, error }) => { if (error) setError(error.message); else setRows(data || []); setLoading(false) }) }, [page,laboratoryId])
  const isBorrowers = page === 'Borrowers', isReturns = page === 'Returns', isHistory = page === 'Transaction History', isAdmins = page === 'Admins', isApprovals = page === 'Admin Approvals'
  const activeReturns = rows.filter(r => !r.returned_at)
  const activeLoanUnits = new Set(activeReturns.map(row => row.unit_id))
  const shelvesNeedingReturnReview = shelves.filter(shelf => activeUnits(shelf).some(unit => unit.status === 'borrowed' && !activeLoanUnits.has(unit.id)))
  const returnStatusWarning = !loading && !error && shelvesNeedingReturnReview.length > 0 && <div className="return-status-warning" role="status"><p>Some equipment is marked borrowed but has no active loan record. Open its shelf and use Return to confirm physical presence and correct its status.</p><div className="unit-action-buttons">{shelvesNeedingReturnReview.map(shelf => <button type="button" className="secondary" key={shelf.id} onClick={() => onOpenShelf(shelf)}>Review {shelf.code}</button>)}</div></div>
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
  const returnModal = returning && <div className="modal-backdrop"><div className="return-modal"><div className="return-modal-icon">↩</div><span className="eyebrow">PROCESS RETURN</span><h2>Return item</h2><p>Confirm the condition of <b>{returning.checkout_shelf_code || returning.inventory_units?.shelves?.code || 'the item'} #{String(returning.checkout_unit_number ?? returning.inventory_units?.unit_number ?? '').padStart(3,'0')}</b> returned by <b>{returning.borrowers?.name || 'the borrower'}</b>.</p><label>Return condition<select disabled={returnBusy} value={returnCondition} onChange={e=>setReturnCondition(e.target.value)}><option value="good">Good</option><option value="damaged">Damaged</option></select></label>{error && <div role="alert" className="connection-error">{error}</div>}<div className="return-modal-actions"><button className="secondary" onClick={()=>setReturning(null)} disabled={returnBusy}>Cancel</button><button className="primary" onClick={confirmReturn} disabled={returnBusy}>Confirm return</button></div></div></div>
  async function approve(row, requestedRole) { const added = await supabase.from('user_accounts').insert({ full_name: row.full_name, email: row.email, role: requestedRole, status: 'active' }); if (added.error) { setError(added.error.message); return } const changed = await supabase.from('account_approvals').update({ status: 'approved', requested_role: requestedRole, reviewed_by: 'Current Admin', reviewed_at: new Date().toISOString() }).eq('id', row.id); if (changed.error) setError(changed.error.message); else setRows(rows.filter(item => item.id !== row.id)) }
  if (isHistory) { const filteredTransactions = rows.filter(r => transactionFilter === 'all' || (transactionFilter === 'returned' ? Boolean(r.returned_at) : !r.returned_at)); return <section className="card page"><div className="cardhead"><div><h2>Transaction History</h2><p>All checkout and return records.</p></div><div className="history-controls"><select value={transactionFilter} onChange={e=>setTransactionFilter(e.target.value)}><option value="all">All items</option><option value="borrowed">Borrowed</option><option value="returned">Returned</option></select><Badge>{filteredTransactions.length} records</Badge></div></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && !filteredTransactions.length && <div className="empty">No transactions match this filter.</div>}{filteredTransactions.length > 0 && <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>BORROWED BY</th><th>RETURNED BY</th><th>STATUS</th></tr></thead><tbody>{filteredTransactions.map(r=><tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.checkout_item_name && <><b>{r.checkout_item_name}</b><br/></>}{r.checkout_shelf_code || r.inventory_units?.shelves?.code || '—'} #{String(r.checkout_unit_number ?? r.inventory_units?.unit_number ?? '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td>{r.borrowed_by || '—'}</td><td>{r.returned_by || '—'}</td><td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td></tr>)}</tbody></table>}</section> }
  if (isReturns) return <section className="card page"><div className="cardhead"><div><h2>Returns</h2><p>Process borrowed items returned to the laboratory.</p></div><Badge>{activeReturns.length} active</Badge></div>{error && <div className="connection-error">{error}</div>}{returnStatusWarning}{!loading && !error && !activeReturns.length && <div className="empty">No active loan records are waiting for return.</div>}{activeReturns.length > 0 && <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>ACTION</th></tr></thead><tbody>{activeReturns.map(r => <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.checkout_shelf_code || r.inventory_units?.shelves?.code || '—'} #{String(r.checkout_unit_number ?? r.inventory_units?.unit_number ?? '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><button className="primary" onClick={() => returnItem(r)}>Mark returned</button></td></tr>)}</tbody></table>}{returnModal}</section>
  if (isApprovals) return <section className="card page"><div className="cardhead"><div><h2>Admin Approvals</h2><p>Choose a role before approving each account</p></div><Badge>{rows.length} requests</Badge></div>{error&&<div className="connection-error">{error}</div>}<table><thead><tr><th>NAME</th><th>EMAIL</th><th>ASSIGN ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td>{r.status==='pending'?<select value={r.requested_role || 'Operator'} onChange={e=>setRows(rows.map(x=>x.id===r.id?{...x,requested_role:e.target.value}:x))}><option>Admin</option><option>Operator</option></select>:r.requested_role}</td><td><Badge tone={r.status==='pending'?'':'neutral'}>{r.status}</Badge></td><td>{r.status==='pending'&&<button className="primary" onClick={()=>approve(r,r.requested_role || 'Operator')}>Approve</button>}</td></tr>)}</tbody></table></section>
  return <section className="card page"><div className="cardhead"><div><h2>{page}</h2></div><Badge tone={error ? 'bad' : ''}>{loading ? 'Loading' : error ? 'Error' : rows.length + ' records'}</Badge></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && rows.length === 0 && <div className="empty">No records found in the {page.toLowerCase()} table.</div>}{rows.length > 0 && <table><thead><tr>{(isBorrowers ? ['Name','Student / Employee ID','Created'] : isAdmins ? ['Full name','Email','Status','Created'] : ['Reference','Borrower','Item','Borrowed','Expected return','Returned']).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(r => isBorrowers ? <tr key={r.id}><td><b>{r.name}</b></td><td>{r.identity_number}</td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : isAdmins ? <tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td><Badge tone={r.status === 'disabled' ? 'bad' : ''}>{r.status}</Badge></td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.checkout_shelf_code || r.inventory_units?.shelves?.code || '—'} #{String(r.checkout_unit_number ?? r.inventory_units?.unit_number ?? '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td></tr>)}</tbody></table>}</section>
}

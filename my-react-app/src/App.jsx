import { useEffect, useRef, useState } from 'react'
import './App.css'
import './Theme.css'
import BrandLogo from './BrandLogo'
import { fetchShelves, fetchLaboratories, fetchTransactions, fetchApprovals, isSupabaseConfigured, supabase } from './lib/supabase'
import { InventoryLabels, InventoryScanner } from './InventoryQR'
import { AddShelfDialog, ItemManagement, Reports } from './InventoryFeatures'
import { activeUnits, shelfItems, stockQuantity, availableQuantity, inventoryCategoryTotals } from './lib/inventory'
import { LaboratorySelector, LaboratoryManager } from './Laboratories'
import { storedLaboratory, rememberLaboratory } from './lib/laboratories'
import Users from './Users'
import { assignedLaboratories, resolveAssignedLaboratory, loadUserLaboratories, userRoleLabel } from './lib/userLaboratories'
import InventoryChecks from './InventoryChecks'
import { canCheckInventory } from './lib/inventoryChecks'

const navSections = [
  { title: 'Overview', items: [{ page: 'Dashboard', icon: '⌂' }] },
  { title: 'Inventory', items: [
    { page: 'Shelves', icon: '▥' },
    { page: 'Items', label: 'Equipment and Consumables', icon: '▦' },
    { page: 'Inventory Checks', icon: '▥' },
  ] },
  { title: 'Daily Operations', items: [
    { page: 'Scan QR', icon: '▤' },
    { page: 'Returns', icon: '↔' },
  ] },
  { title: 'Records & Reports', items: [
    { page: 'Transaction History', icon: '✓' },
    { page: 'Reports', icon: '▧' },
  ] },
]
const admin = ['Users','Admin Approvals']
const Badge = ({children,tone=''}) => <span className={'badge '+tone}>{children}</span>

export default function App() {
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 1200px)').matches)
  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 1200px)')
    const update = () => setCompactNavigation(viewport.matches)
    update()
    viewport.addEventListener('change', update)
    return () => viewport.removeEventListener('change', update)
  }, [])
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('inventoscan.theme') === 'dark' ? 'dark' : 'light' }
    catch { return 'light' }
  })
  useEffect(() => {
    try { localStorage.setItem('inventoscan.theme', theme) }
    catch { /* Theme switching still works when browser storage is unavailable. */ }
  }, [theme])
  const [page,setPage] = useState('Dashboard')
  const [mobile,setMobile] = useState(false)
  const navigationToggle = useRef(null)
  const [query,setQuery] = useState('')
  const [allShelves,setAllShelves] = useState([])
  const [laboratories,setLaboratories] = useState([]), [preferredLaboratoryId,setPreferredLaboratoryId] = useState(storedLaboratory)
  const [laboratorySetupRequired,setLaboratorySetupRequired] = useState(false), [managingLaboratories,setManagingLaboratories] = useState(false)
  const refreshVersion = useRef(0), pendingRefreshes = useRef(0)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [currentUser,setCurrentUser] = useState(null)
  const [userAssignments,setUserAssignments] = useState([]), [accountVersion,setAccountVersion] = useState(0)
  const [assignmentError,setAssignmentError] = useState('')
  const [accountLoading,setAccountLoading] = useState(Boolean(supabase)), [assignmentSetupRequired,setAssignmentSetupRequired] = useState(false)
  const [selectedShelf,setSelectedShelf] = useState(null)
  const [addingShelf,setAddingShelf] = useState(false)
  const [migrationRequired,setMigrationRequired] = useState(false)
  const [unitActionsRequired,setUnitActionsRequired] = useState(true)
  const [permanentDeleteRequired,setPermanentDeleteRequired] = useState(true)
  const [itemNamesRequired,setItemNamesRequired] = useState(true)
  const [itemCategoriesRequired,setItemCategoriesRequired] = useState(true)
  async function refreshInventory(preferredLaboratoryId) {
    const version = ++refreshVersion.current
    pendingRefreshes.current++
    try {
      const [inventory,labs] = await Promise.all([fetchShelves(),fetchLaboratories()])
      if (version !== refreshVersion.current) return false
      if (inventory.error || labs.error) throw inventory.error || labs.error
      setAllShelves(inventory.data || []);setLaboratories(labs.data || []);setLaboratorySetupRequired(Boolean(labs.setupRequired))
      if (typeof preferredLaboratoryId === 'string') setPreferredLaboratoryId(preferredLaboratoryId)
      setMigrationRequired(Boolean(inventory.migrationRequired));setUnitActionsRequired(Boolean(inventory.unitActionsRequired))
      setPermanentDeleteRequired(Boolean(inventory.permanentDeleteRequired));setItemNamesRequired(Boolean(inventory.itemNamesRequired))
      setItemCategoriesRequired(Boolean(inventory.itemCategoriesRequired));setError('')
      return true
    } catch (failure) { if (version === refreshVersion.current) setError(failure.message);return false }
    finally { pendingRefreshes.current--; if (version === refreshVersion.current) setLoading(false) }
  }
  function selectLaboratory(id) {
    if (!availableLaboratories.some(laboratory=>laboratory.id===id)) return
    setPreferredLaboratoryId(id);setQuery('');setSelectedShelf(null);setAddingShelf(false);setMobile(false)
  }
  useEffect(() => {
    let active = true
    const invalidate = () => { refreshVersion.current++ }
    Promise.resolve().then(()=>{if(active)refreshInventory()})
    const refreshAccountAndInventory = () => { if (document.visibilityState !== 'visible') return; if (!pendingRefreshes.current) refreshInventory(); setAccountVersion(value=>value+1) }
    const timer = setInterval(refreshAccountAndInventory, 30000)
    const refresh = () => { if (document.visibilityState === 'visible') refreshAccountAndInventory() }
    document.addEventListener('visibilitychange', refresh)
    return () => { active = false; invalidate(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => {
    let active = true
    supabase?.auth.getUser().then(async ({ data, error: authError }) => {
      if (!active) return
      if (authError) throw authError
      if (!data.user) { setCurrentUser(null); setUserAssignments([]); return }
      const { data: account, error: accountError } = await supabase.from('user_accounts').select('id,full_name,email,role,status').eq('email', data.user.email).maybeSingle()
      if (!active) return
      if (accountError) { setAssignmentError(accountError.message); setCurrentUser(null); setUserAssignments([]); return }
      setCurrentUser(account || { full_name: data.user.user_metadata?.full_name || 'User', email: data.user.email, role: 'Operator' })
      if (account?.role !== 'Admin') setPage(previous => admin.includes(previous) ? 'Dashboard' : previous)
      if (account?.id && account.role !== 'Admin') {
        const result = await loadUserLaboratories(supabase, account.id)
        if (!active) return
        setUserAssignments(result.data || []); setAssignmentError(result.error?.message || ''); setAssignmentSetupRequired(Boolean(result.setupRequired))
      } else { setUserAssignments([]); setAssignmentError(''); setAssignmentSetupRequired(false) }
    }).catch(failure => { if (active) { setAssignmentError(failure.message); setCurrentUser(null); setUserAssignments([]) } })
      .finally(()=>{if(active)setAccountLoading(false)})
    return () => { active = false }
  }, [accountVersion])
  const availableLaboratories = accountLoading ? [] : assignedLaboratories(laboratories,currentUser,userAssignments)
  const laboratoryId = resolveAssignedLaboratory(availableLaboratories,preferredLaboratoryId)
  useEffect(() => { if (!accountLoading && !loading) rememberLaboratory(laboratoryId) }, [laboratoryId,accountLoading,loading])
  const selectedLaboratory = availableLaboratories.find(lab => lab.id === laboratoryId)
  const scopedLaboratoryId = laboratorySetupRequired ? null : selectedLaboratory?.id || null
  const dbShelves = laboratoryId ? allShelves.filter(shelf => shelf.laboratory_id === laboratoryId) : []
  const canManageInventory = !!selectedLaboratory && !accountLoading
  const isSystemAdmin = currentUser?.role==='Admin' && currentUser?.status==='active'
  const canInspect = !laboratorySetupRequired && canCheckInventory(currentUser,userAssignments,scopedLaboratoryId)
  const shelves = dbShelves.filter(s => (s.code+' '+s.name+' '+shelfItems(s).map(item => item.name).join(' ')).toLowerCase().includes(query.toLowerCase()))
  const inventoryTotals = dbShelves.reduce((totals,shelf) => {
    const shelfTotals = inventoryCategoryTotals(shelf)
    totals.equipment += shelfTotals.equipment
    totals.consumables += shelfTotals.consumables
    return totals
  }, { equipment:0, consumables:0 })
  const go = name => { if (name==='Inventory Checks' && !canInspect) return; setPage(name); setMobile(false) }
  const compactPage = ['Shelves','Returns','Transaction History','Inventory Checks','Reports'].includes(page)
  const hidePageHeader = compactPage || page === 'Items'
  const shelvesPage = page === 'Dashboard' || page === 'Shelves'
  const laboratoryControls = <LaboratorySelector laboratories={availableLaboratories} selectedId={laboratoryId} loading={loading || accountLoading} onManage={isSystemAdmin ? ()=>setManagingLaboratories(true) : undefined} onSelect={selectLaboratory}/>
  const administrationLinks = isSystemAdmin && <nav className={compactNavigation ? 'sidebar-admin-nav' : 'header-admin-nav'} aria-label="Administration">{admin.map(name => <button type="button" key={name} className={page === name ? 'active' : ''} aria-current={page === name ? 'page' : undefined} onClick={() => go(name)}><span aria-hidden="true">⚙</span> {name}</button>)}</nav>
  return <div className={page === 'Transaction History' ? 'app history-view' : 'app'} data-theme={theme}><MainBrand theme={theme} onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>
      {!compactNavigation && <>{laboratoryControls}{administrationLinks}</>}
    </MainBrand>
    <aside id="app-sidebar" className={mobile ? 'side open' : 'side'}>
      {mobile && <button type="button" className="sidebar-close" aria-label="Close sidebar" title="Close sidebar" onClick={() => { setMobile(false); navigationToggle.current?.focus() }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}
      <div className="brand"><BrandLogo/><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div><div className="sidebar-user"><div className="user-avatar">{(currentUser?.full_name || 'U').charAt(0).toUpperCase()}</div><div><b>{currentUser?.full_name || 'Loading user...'}</b><small>{currentUser?.email || ''}</small><span>{currentUser ? userRoleLabel(currentUser,userAssignments,laboratoryId) : 'Loading role…'}{currentUser?.role !== 'Admin' && userAssignments.some(row=>row.user_id===currentUser?.id && row.laboratory_id===laboratoryId) && selectedLaboratory && ` · ${selectedLaboratory.name}`}</span></div></div><div className="sidebar-navigation">
      {compactNavigation && <div className="sidebar-laboratories">{laboratoryControls}</div>}
      {navSections.map(section =>
      <section className="sidebar-section" key={section.title} aria-label={section.title}>
        <h2 className="sidebar-section-title">{section.title}</h2>
        <nav aria-label={section.title}>{section.items.filter(item=>item.page!=='Inventory Checks'||canInspect).map(item => <button type="button" className={page===item.page?'active':''} aria-current={page===item.page?'page':undefined} onClick={()=>go(item.page)} key={item.page}><span aria-hidden="true">{item.icon}</span> {item.label || item.page}</button>)}</nav>
      </section>
    )}
      {compactNavigation && isSystemAdmin && <section className="sidebar-section" aria-label="Administration links"><h2 className="sidebar-section-title">Administration</h2>{administrationLinks}</section>}
    </div><nav className="sidebar-footer" aria-label="Account"><button type="button" onClick={()=>supabase?.auth.signOut()}><span aria-hidden="true">↪</span> Log out</button></nav></aside>
    {managingLaboratories && isSystemAdmin && <LaboratoryManager laboratories={laboratories} shelves={allShelves} setupRequired={laboratorySetupRequired} onClose={()=>setManagingLaboratories(false)} onChange={async preferredId=>{if(!await refreshInventory(preferredId))throw new Error('Changes were saved, but inventory could not be refreshed. Refresh the page.')}}/>}
    <main key={laboratoryId || 'no-laboratory'} className={[compactPage && 'compact-page', shelvesPage && 'shelves-layout', page === 'Transaction History' && 'history-layout'].filter(Boolean).join(' ') || undefined}><header className={hidePageHeader ? 'inventory-page-header' : undefined}><button ref={navigationToggle} className="mobile" aria-label={mobile ? 'Close navigation' : 'Open navigation'} aria-expanded={mobile} aria-controls="app-sidebar" onClick={()=>setMobile(!mobile)}>☰</button>{!hidePageHeader && <div><h1>{page}</h1><p>{isSupabaseConfigured ? selectedLaboratory?.name || 'Laboratory inventory' : 'Connection setup required'}</p></div>}</header>
    {assignmentError && <div role="alert" className="connection-error">Could not load account assignments: {assignmentError}</div>}
    {error && <div className="connection-error"><b>Database connection error:</b> {error}</div>}
    {accountLoading && <p role="status">Loading your laboratory assignments…</p>}
    {!loading && !accountLoading && !error && !canManageInventory && ['Dashboard','Shelves','Items','Scan QR','Reports','Returns','Transaction History','Inventory Checks'].includes(page) && <section className="card page"><h2>{isSystemAdmin ? 'No laboratories available' : 'No laboratory assigned'}</h2><p>{assignmentSetupRequired || laboratorySetupRequired ? 'Laboratory assignments need a system update. Please contact your System Admin.' : isSystemAdmin ? 'Create a laboratory to start managing its inventory.' : 'Ask your System Admin to assign you to a laboratory.'}</p>{isSystemAdmin && <button type="button" className="primary" onClick={()=>go('Users')}>Open Users</button>}{isSystemAdmin && !laboratories.length && <button type="button" className="secondary" onClick={()=>setManagingLaboratories(true)}>Add laboratory</button>}</section>}

    {migrationRequired && <section className="card inventory-alerts" role="status"><h2>Inventory setup required</h2><p>You can view inventory. Ask an administrator to complete setup before managing stock, reports, and equipment loans.</p></section>}
    {!migrationRequired && unitActionsRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Equipment management update required</h2><p>Ask an administrator to update equipment management before moving or deleting equipment.</p></section>}
    {!migrationRequired && permanentDeleteRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Deletion update required</h2><p>Ask an administrator to enable permanent deletion for shelves and items.</p></section>}
    {!migrationRequired && itemNamesRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Item management update required</h2><p>Ask an administrator to update item management before adding named items or issuing stock by item.</p></section>}
    {!migrationRequired && !itemNamesRequired && itemCategoriesRequired && !loading && <section className="card inventory-alerts" role="status"><h2>Consumable stock update required</h2><p>Ask an administrator to update consumable stock tracking before adding or issuing quantities.</p></section>}
    {page==='Dashboard' && canManageInventory && <section className="stats">{[['Shelves',dbShelves.length,'Total shelves','▥'],['Equipments',inventoryTotals.equipment,'Total equipment','▤'],['Consumables',inventoryTotals.consumables,'Total quantity','▦']].map((x,i)=><div className="stat" key={x[0]}><i className={'c'+i}>{x[3]}</i><small>{x[0]}</small><strong>{loading?'…':x[1]}</strong><em>{x[2]}</em></div>)}</section>}
    {page==='Users' && isSystemAdmin && <Users currentUser={currentUser} laboratories={laboratories} laboratorySetupRequired={laboratorySetupRequired} onAccountChange={()=>setAccountVersion(value=>value+1)}/>}
    {page==='Inventory Checks' && canManageInventory && (canInspect
      ? <InventoryChecks laboratoryId={scopedLaboratoryId} shelves={dbShelves} onChange={refreshInventory} inventoryLoading={loading} inventoryError={error} setupRequired={migrationRequired || itemNamesRequired || itemCategoriesRequired}/>
      : <section className="card page"><h2>Inventory Checks</h2><p>System Admins and assigned laboratory staff can check inventory in this laboratory.</p></section>)}
    {page==='Items' && canManageInventory && !migrationRequired && <ItemManagement shelves={dbShelves} onChange={refreshInventory} onUnitQR={(shelf, unit) => setSelectedShelf({ ...shelf, qrUnit: unit })}/>}
    {page==='Reports' && canManageInventory && !loading && !error && !migrationRequired && <Reports shelves={dbShelves}/>}
    {page==='Scan QR' && canManageInventory && <InventoryScanner laboratoryId={scopedLaboratoryId} onChange={refreshInventory} migrationRequired={migrationRequired} itemNamesRequired={itemNamesRequired} itemCategoriesRequired={itemCategoriesRequired}/>}
    {canManageInventory && shelvesPage && <section className="card page shelves-panel">
      <div className="cardhead"><div><h2>{page==='Dashboard'?'Shelves':page}</h2><p>{loading?'Loading shelves…':`${shelves.length} ${shelves.length === 1 ? 'shelf' : 'shelves'}`}</p></div>
        <div className="shelf-page-actions"><button type="button" className="primary shelf-add-button" disabled={loading || Boolean(error) || migrationRequired} onClick={()=>setAddingShelf(true)}>Add shelf</button>{(loading || error) && <Badge tone={error?'bad':''}>{loading?'Loading':'Error'}</Badge>}</div>
      </div>
      {page!=='Dashboard' && <div className="search">⌕ <input aria-label="Search shelves" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search shelves..."/></div>}
      <div className="shelves-scroll" role="region" aria-label="Shelves list" tabIndex={0}>
      {!loading && !error && !shelves.length && <div className="empty shelf-empty-state">{dbShelves.length ? <><p>No shelves match your search.</p><button type="button" className="secondary" onClick={()=>setQuery('')}>Clear search</button></> : <><p>No shelves yet. Add your first shelf to start managing inventory.</p><button type="button" className="primary" disabled={migrationRequired} onClick={()=>setAddingShelf(true)}>Add your first shelf</button></>}</div>}
      <div className="shelves">{shelves.map(s=>{
        const totals = inventoryCategoryTotals(s)
        return <article className="shelf" key={s.id} onClick={()=>setSelectedShelf(s)}><div><i>▥</i><Badge>{availableQuantity(s)} available</Badge></div><h2>{s.name}</h2><p>{s.code}</p>{s.description && <p className="item-description">{s.description}</p>}<hr/>
          <div className="shelf-category-totals"><small><b>{totals.equipment}</b> total equipment</small><small><b>{totals.consumables}</b> total consumables</small></div>
          <small className="shelf-stock-total"><b>{stockQuantity(s)}</b> total quantity <span>{activeUnits(s).filter(u=>u.status==='borrowed').length} borrowed</span></small>
        </article>
      })}</div></div>
    </section>}
    {addingShelf && canManageInventory && <AddShelfDialog laboratoryId={scopedLaboratoryId} onClose={()=>setAddingShelf(false)} onSaved={async()=>{ setQuery(''); await refreshInventory(); setAddingShelf(false) }}/>}
    {selectedShelf && dbShelves.some(shelf=>shelf.id===selectedShelf.id) && <InventoryLabels key={selectedShelf.id + (selectedShelf.qrUnit?.id || '')} shelf={{ ...(dbShelves.find(shelf => shelf.id === selectedShelf.id) || selectedShelf), qrUnit: selectedShelf.qrUnit }} shelves={dbShelves} close={()=>setSelectedShelf(null)} onChange={refreshInventory} migrationRequired={migrationRequired} unitActionsRequired={unitActionsRequired} permanentDeleteRequired={permanentDeleteRequired} itemNamesRequired={itemNamesRequired} itemCategoriesRequired={itemCategoriesRequired} />}
    {((canManageInventory && ['Returns','Transaction History'].includes(page)) || (isSystemAdmin && page==='Admin Approvals')) && <DatabaseTable key={`${page}:${laboratoryId}`} laboratoryId={scopedLaboratoryId} page={page} onChange={refreshInventory} migrationRequired={migrationRequired} shelves={dbShelves} onOpenShelf={setSelectedShelf}/>}
    </main></div>
}

function MainBrand({ children, theme, onToggleTheme }) {
  const dark = theme === 'dark'
  return <div className="main-brand-user"><div className="brand"><BrandLogo/><span><strong>VSU InventoScan</strong><small>Inventory system</small></span></div><div className="header-controls">{children}</div>
    <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} aria-pressed={dark} title={`Switch to ${dark ? 'light' : 'dark'} mode`}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {dark ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> : <path d="M20.7 13.1A9 9 0 0 1 10.9 3.3 9 9 0 1 0 20.7 13.1Z"/>}
      </svg><span>{dark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  </div>
}

function DatabaseTable({ page, onChange, migrationRequired, shelves = [], onOpenShelf, laboratoryId }) {
  const [returnBusy, setReturnBusy] = useState(false), [approvingId,setApprovingId] = useState(null)
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [transactionFilter, setTransactionFilter] = useState('all')
  const [returning, setReturning] = useState(null), [returnCondition, setReturnCondition] = useState('good')
  useEffect(() => {
    let active = true
    const load = page === 'Returns' || page === 'Transaction History' ? fetchTransactions(page === 'Returns',laboratoryId) : page === 'Admin Approvals' ? fetchApprovals() : Promise.resolve({ data: [] })
    load.then(({ data, error }) => { if (!active) return; if (error) setError(error.message); else setRows(data || []) })
      .catch(failure=>{if(active)setError(failure.message)})
      .finally(()=>{if(active)setLoading(false)})
    return ()=>{active=false}
  }, [page,laboratoryId])
  const isReturns = page === 'Returns', isHistory = page === 'Transaction History', isApprovals = page === 'Admin Approvals'
  const activeReturns = rows.filter(r => !r.returned_at)
  const activeLoanUnits = new Set(activeReturns.map(row => row.unit_id))
  const shelvesNeedingReturnReview = shelves.filter(shelf => activeUnits(shelf).some(unit => unit.status === 'borrowed' && !activeLoanUnits.has(unit.id)))
  const returnStatusWarning = !loading && !error && shelvesNeedingReturnReview.length > 0 && <div className="return-status-warning" role="status"><p>Some equipment is marked borrowed but has no active loan record. Open its shelf and use Return to confirm physical presence and correct its status.</p><div className="unit-action-buttons">{shelvesNeedingReturnReview.map(shelf => <button type="button" className="secondary" key={shelf.id} onClick={() => onOpenShelf(shelf)}>Review {shelf.code}</button>)}</div></div>
  function returnItem(row) { setReturning(row); setReturnCondition('good') }
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
  async function approve(row, requestedRole) {
    if (approvingId) return
    setApprovingId(row.id);setError('')
    try {
      const {error:failure}=await supabase.rpc('inventory_approve_account',{p_approval_id:row.id,p_role:requestedRole})
      if(failure)throw failure
      setRows(previous=>previous.filter(item=>item.id!==row.id))
    }catch(failure){setError(failure.code==='PGRST202'?'Account approvals need the security update. Please contact your System Admin.':failure.message)}
    finally{setApprovingId(null)}
  }
  if (isHistory) {
    const filteredTransactions = rows.filter(r => transactionFilter === 'all' || (transactionFilter === 'returned' ? Boolean(r.returned_at) : !r.returned_at))
    return <section className="card page transaction-history">
      <div className="cardhead"><div><h2>Transaction History</h2><p>All checkout and return records.</p></div><div className="history-controls">
        <div className="history-filter-buttons" role="group" aria-label="Filter transaction history">{[['all','All'],['borrowed','Borrow'],['returned','Return']].map(([value,label]) => <button key={value} type="button" aria-pressed={transactionFilter === value} onClick={() => setTransactionFilter(value)}>{label}</button>)}</div>
        <Badge>{filteredTransactions.length} {filteredTransactions.length === 1 ? 'record' : 'records'}</Badge>
      </div></div>
      {error && <div className="connection-error">{error}</div>}
      {!loading && !error && !filteredTransactions.length && <div className="empty">No transactions match this filter.</div>}
      {filteredTransactions.length > 0 && <div className="history-table-scroll" role="region" aria-label="Transaction records" tabIndex={0}>
        <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>BORROWED BY</th><th>RETURNED BY</th><th>STATUS</th></tr></thead>
          <tbody>{filteredTransactions.map(r => <tr key={r.id}>
            <td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td>
            <td>{r.checkout_item_name && <><b>{r.checkout_item_name}</b><br/></>}{r.checkout_shelf_code || r.inventory_units?.shelves?.code || '—'} #{String(r.checkout_unit_number ?? r.inventory_units?.unit_number ?? '').padStart(3,'0')}</td>
            <td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td>{r.borrowed_by || '—'}</td><td>{r.returned_by || '—'}</td>
            <td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  }
  if (isReturns) return <section className="card page"><div className="cardhead"><div><h2>Returns</h2><p>Process borrowed items returned to the laboratory.</p></div><Badge>{activeReturns.length} active</Badge></div>{error && <div className="connection-error">{error}</div>}{returnStatusWarning}{!loading && !error && !activeReturns.length && <div className="empty">No active loan records are waiting for return.</div>}{activeReturns.length > 0 && <table><thead><tr><th>REFERENCE</th><th>BORROWER</th><th>ITEM</th><th>BORROWED</th><th>EXPECTED RETURN</th><th>ACTION</th></tr></thead><tbody>{activeReturns.map(r => <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.checkout_shelf_code || r.inventory_units?.shelves?.code || '—'} #{String(r.checkout_unit_number ?? r.inventory_units?.unit_number ?? '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><button className="primary" onClick={() => returnItem(r)}>Mark returned</button></td></tr>)}</tbody></table>}{returnModal}</section>
  if (isApprovals) return <section className="card page"><div className="cardhead"><div><h2>Admin Approvals</h2><p>Choose a system role before approving each account</p></div><Badge>{rows.length} requests</Badge></div>{loading && <p role="status">Loading requests…</p>}{!loading && !error && !rows.length && <p className="empty">No pending account requests.</p>}{error&&<div className="connection-error">{error}</div>}<table><thead><tr><th>NAME</th><th>EMAIL</th><th>ASSIGN ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td>{r.status==='pending'?<select aria-label={`Role for ${r.full_name}`} disabled={Boolean(approvingId)} value={r.requested_role || 'Operator'} onChange={e=>setRows(rows.map(x=>x.id===r.id?{...x,requested_role:e.target.value}:x))}><option value="Admin">System Admin</option><option value="Operator">Laboratory member</option></select>:r.requested_role}</td><td><Badge tone={r.status==='pending'?'':'neutral'}>{r.status}</Badge></td><td>{r.status==='pending'&&<button className="primary" disabled={Boolean(approvingId)} onClick={()=>approve(r,r.requested_role || 'Operator')}>{approvingId===r.id?'Approving…':'Approve'}</button>}</td></tr>)}</tbody></table></section>
  return null
}

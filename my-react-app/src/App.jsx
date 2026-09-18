import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { fetchShelves, fetchBorrowers, fetchTransactions, fetchAdmins, fetchUsers, fetchApprovals, isSupabaseConfigured, supabase } from './lib/supabase'
import QRCode from 'qrcode'

const nav = ['Dashboard','Scan QR','Inventory','Shelves','Borrowers','Transactions','Inventory Checks','Reports']
const admin = ['Users','Admin Approvals','Permissions','Activity Logs','Settings']
const Badge = ({children,tone=''}) => <span className={'badge '+tone}>{children}</span>

export default function App() {
  const [page,setPage] = useState('Dashboard')
  const [mobile,setMobile] = useState(false)
  const [query,setQuery] = useState('')
  const [dbShelves,setDbShelves] = useState([])
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [selectedShelf,setSelectedShelf] = useState(null)
  useEffect(() => { fetchShelves().then(({data,error}) => { if(error) setError(error.message); else setDbShelves(data || []); setLoading(false) }) }, [])
  const shelves = useMemo(() => dbShelves.filter(s => (s.code+' '+s.name+' '+s.item_type).toLowerCase().includes(query.toLowerCase())), [dbShelves,query])
  const units = dbShelves.flatMap(s => s.inventory_units || [])
  const count = status => units.filter(u => u.status === status).length
  const go = name => { setPage(name); setMobile(false) }
  return <div className="app">
    <aside className={mobile ? 'side open' : 'side'}><div className="brand"><b>⌁</b><span><strong>Stockly</strong><small>Inventory system</small></span></div><div className="workspace">● Science Laboratory　⌄</div><label>MAIN MENU</label><nav>{nav.map((n,i)=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>{['⌂','▤','▥','♙','↔','✓','▥'][i]} {n}</button>)}</nav><label>ADMINISTRATION</label><nav>{admin.map(n=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>⚙ {n}</button>)}</nav></aside>
    <main><header><button className="mobile" onClick={()=>setMobile(!mobile)}>☰</button><div><label>SUPABASE DATABASE</label><h1>{page}</h1><p>{isSupabaseConfigured?'Live data connection':'Environment variables are missing'}</p></div><div className="head"><span>{isSupabaseConfigured?'Connected':'Not connected'}</span><button className="logout" onClick={()=>supabase?.auth.signOut()}>Log out</button></div></header>
    {error && <div className="connection-error"><b>Database connection error:</b> {error}</div>}
    {page==='Dashboard' && <section className="stats">{[['Total units',units.length,'From Supabase','▤'],['Available',count('available'),'Live inventory count','✓'],['Borrowed',count('borrowed'),'Live inventory count','↗'],['Needs attention',units.filter(u=>u.status==='under_maintenance'||u.condition==='damaged').length,'Damaged or maintenance','!']].map((x,i)=><div className="stat" key={x[0]}><i className={'c'+i}>{x[3]}</i><small>{x[0]}</small><strong>{loading?'…':x[1]}</strong><em>{x[2]}</em></div>)}</section>}
    {page==='Scan QR' && <Scanner />}
    {(page==='Dashboard'||page==='Shelves'||page==='Inventory') && <section className="card page"><div className="cardhead"><div><h2>{page==='Dashboard'?'Shelves from Supabase':page}</h2><p>{loading?'Loading database records…':shelves.length+' shelf records loaded from Supabase'}</p></div><Badge tone={error?'bad':''}>{loading?'Loading':error?'Error':'Connected'}</Badge></div>{page!=='Dashboard'&&<div className="search">⌕ <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search shelves..."/></div>}{!loading&&!error&&!shelves.length&&<div className="empty">No shelves found. Run seed.sql in Supabase, then refresh.</div>}<div className="shelves">{shelves.map(s=><article className="shelf" key={s.id} onClick={()=>setSelectedShelf(s)}><div><i>▥</i><Badge>{(s.inventory_units||[]).filter(u=>u.status==='available').length} available</Badge></div><h2>{s.name}</h2><p>{s.code} · {s.item_type}</p><hr/><small><b>{(s.inventory_units||[]).length}</b> total units <span>{(s.inventory_units||[]).filter(u=>u.status==='borrowed').length} borrowed</span></small></article>)}</div></section>}
    {selectedShelf && <ShelfQR shelf={selectedShelf} close={()=>setSelectedShelf(null)} />}
    {page!=='Dashboard'&&page!=='Shelves'&&page!=='Inventory'&&<DatabaseTable page={page}/>} 
    </main></div>
}

function Scanner() {
  const [value, setValue] = useState(''), [result, setResult] = useState(null), [error, setError] = useState(''), [scanning, setScanning] = useState(false), [borrowers, setBorrowers] = useState([]), [borrowerId, setBorrowerId] = useState(''), [borrowerName, setBorrowerName] = useState(''), [identity, setIdentity] = useState(''), [unitId, setUnitId] = useState(''), [done, setDone] = useState('')
  const video = useRef(null), stream = useRef(null)
  useEffect(() => () => stream.current?.getTracks().forEach(track => track.stop()), [])
  async function startCamera() {
    setError(''); setResult(null)
    if (!('BarcodeDetector' in window)) { setError('QR scanning is not supported by this browser. Enter the code manually.'); return }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      video.current.srcObject = stream.current; await video.current.play(); setScanning(true); detect()
    } catch (e) { setError(e.message || 'Camera permission was denied.') }
  }
  async function detect() {
    if (!video.current || !stream.current) return
    const detector = new BarcodeDetector({ formats: ['qr_code'] })
    const codes = await detector.detect(video.current).catch(() => [])
    if (codes[0]?.rawValue) { setValue(codes[0].rawValue); stopCamera(); lookup(codes[0].rawValue) }
    else if (stream.current) requestAnimationFrame(detect)
  }
  function stopCamera() { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; setScanning(false) }
  async function lookup(code = value) {
    if (!code.trim()) return
    setError(''); setResult(null)
    const { data, error: queryError } = await supabase.from('shelves').select('*, inventory_units(*)').eq('qr_value', code.trim()).maybeSingle()
    if (queryError) setError(queryError.message); else if (!data) setError('No shelf found for this QR code.'); else { setResult(data); setUnitId(''); const response = await fetchBorrowers(); setBorrowers(response.data || []) }
  }
  async function checkout(e) { e.preventDefault(); setError(''); setDone(''); let borrower = borrowerId ? borrowers.find(b => b.id === borrowerId) : null; if (!borrower) { if (!borrowerName.trim() || !identity.trim()) { setError('Select a borrower or enter a name and ID.'); return }; const added = await supabase.from('borrowers').insert({ name: borrowerName.trim(), identity_number: identity.trim() }).select().single(); if (added.error) { setError(added.error.message); return }; borrower = added.data } if (!unitId) { setError('Select an available item.'); return } const transaction = await supabase.from('transactions').insert({ borrower_id: borrower.id, unit_id: unitId, expected_return_at: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) }); if (transaction.error) { setError(transaction.error.message); return }; const updated = await supabase.from('inventory_units').update({ status: 'borrowed' }).eq('id', unitId); if (updated.error) { setError(updated.error.message); return }; setDone('Item checked out successfully.'); setResult({ ...result, inventory_units: result.inventory_units.map(u => u.id === unitId ? { ...u, status: 'borrowed' } : u) }); setUnitId('') }
  return <section className="card page scanner-page"><div className="cardhead"><div><h2>Scan inventory QR</h2><p>Scan a shelf label to view its live stock.</p></div><Badge>Operator</Badge></div><div className="scanner-grid"><div className="scanner-camera"><video ref={video} muted playsInline /><div className={scanning ? 'scan-line active' : 'scan-line'}></div>{!scanning && <div className="camera-placeholder">▣<span>Camera preview</span></div>}</div><div className="scanner-controls"><button className="primary" onClick={scanning ? stopCamera : startCamera}>{scanning ? 'Stop camera' : 'Open camera'}</button><div className="or">or enter the QR value</div><div className="scan-input"><input value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} placeholder="e.g. SHELF-A-01"/><button onClick={() => lookup()}>Search</button></div><small>Allow camera access when prompted. Manual entry works on every device.</small>{error && <div className="connection-error">{error}</div>}</div></div>{result && <div className="scan-result"><div className="result-title"><div><span className="eyebrow">SHELF FOUND</span><h2>{result.name}</h2><p>{result.code} · {result.item_type}</p></div><Badge>{result.inventory_units.length} units</Badge></div><div className="unit-list">{result.inventory_units.map(unit => <div className="unit-row" key={unit.id}><b>Unit {String(unit.unit_number).padStart(3, '0')}</b><Badge tone={unit.status==='available'?'':'neutral'}>{unit.status.replace('_',' ')}</Badge><span>{unit.condition}</span></div>)}</div></div>}</section>
}

function ShelfQR({ shelf, close }) {
  const [image, setImage] = useState('')
  useEffect(() => { QRCode.toDataURL(shelf.qr_value, { width: 260, margin: 2 }).then(setImage) }, [shelf.qr_value])
  function download() { const link = document.createElement('a'); link.href = image; link.download = `${shelf.code}-qr.png`; link.click() }
  return <div className="backdrop" onClick={close}><div className="modal qr-modal" onClick={e=>e.stopPropagation()}><button className="x" onClick={close}>×</button><span className="eyebrow">ITEM QR CODE</span><h2>{shelf.name}</h2><p>{shelf.code} · {shelf.item_type}</p>{image ? <img className="qr-image" src={image} alt={`QR code for ${shelf.name}`} /> : <div className="qr">Generating…</div>}<code className="qr-value">{shelf.qr_value}</code><button className="primary full" onClick={download} disabled={!image}>Download QR</button></div></div>
}

function DatabaseTable({ page }) {
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [roleFilter, setRoleFilter] = useState('All')
  useEffect(() => { const load = page === 'Borrowers' ? fetchBorrowers() : page === 'Transactions' ? fetchTransactions() : page === 'Users' ? fetchUsers() : page === 'Admin Approvals' ? fetchApprovals() : Promise.resolve({ data: [] }); load.then(({ data, error }) => { if (error) setError(error.message); else setRows(data || []); setLoading(false) }) }, [page])
  const isBorrowers = page === 'Borrowers', isAdmins = page === 'Admins', isUsers = page === 'Users', isApprovals = page === 'Admin Approvals'
  const visibleUsers = rows.filter(r => roleFilter === 'All' || r.role === roleFilter)
  async function changeRole(user, role) { const { error: x } = await supabase.from('user_accounts').update({ role }).eq('id', user.id); if (x) setError(x.message); else setRows(rows.map(r => r.id === user.id ? { ...r, role } : r)) }
  if (isUsers) return <section className="card page"><div className="cardhead"><div><h2>Users</h2><p>Manage Admin and Operator accounts</p></div><Badge>{visibleUsers.length} users</Badge></div><div className="toolbar"><div className="search"><input placeholder="Search users..." onChange={e => setRows(rows.filter(r => r.full_name.toLowerCase().includes(e.target.value.toLowerCase()) || r.email.toLowerCase().includes(e.target.value.toLowerCase())))} /></div><select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option>All</option><option>Admin</option><option>Operator</option></select></div><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>CHANGE ROLE</th></tr></thead><tbody>{visibleUsers.map(r => <tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td><Badge>{r.role}</Badge></td><td>{r.status}</td><td><select value={r.role} onChange={e => changeRole(r,e.target.value)}><option>Admin</option><option>Operator</option></select></td></tr>)}</tbody></table></section>
  async function approve(row, requestedRole) { const added = await supabase.from('user_accounts').insert({ full_name: row.full_name, email: row.email, role: requestedRole, status: 'active' }); if (added.error) { setError(added.error.message); return } const changed = await supabase.from('account_approvals').update({ status: 'approved', requested_role: requestedRole, reviewed_by: 'Current Admin', reviewed_at: new Date().toISOString() }).eq('id', row.id); if (changed.error) setError(changed.error.message); else setRows(rows.filter(item => item.id !== row.id)) }
  if (isApprovals) return <section className="card page"><div className="cardhead"><div><h2>Admin Approvals</h2><p>Choose a role before approving each account</p></div><Badge>{rows.length} requests</Badge></div>{error&&<div className="connection-error">{error}</div>}<table><thead><tr><th>NAME</th><th>EMAIL</th><th>ASSIGN ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td>{r.status==='pending'?<select value={r.requested_role || 'Operator'} onChange={e=>setRows(rows.map(x=>x.id===r.id?{...x,requested_role:e.target.value}:x))}><option>Admin</option><option>Operator</option></select>:r.requested_role}</td><td><Badge tone={r.status==='pending'?'':'neutral'}>{r.status}</Badge></td><td>{r.status==='pending'&&<button className="primary" onClick={()=>approve(r,r.requested_role || 'Operator')}>Approve</button>}</td></tr>)}</tbody></table></section>
  return <section className="card page"><div className="cardhead"><div><h2>{page}</h2><p>Live records loaded from Supabase</p></div><Badge tone={error ? 'bad' : ''}>{loading ? 'Loading' : error ? 'Error' : rows.length + ' records'}</Badge></div>{error && <div className="connection-error">{error}</div>}{!loading && !error && rows.length === 0 && <div className="empty">No records found in the {page.toLowerCase()} table.</div>}{rows.length > 0 && <table><thead><tr>{(isBorrowers ? ['Name','Student / Employee ID','Created'] : isAdmins ? ['Full name','Email','Status','Created'] : ['Reference','Borrower','Item','Borrowed','Expected return','Returned']).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(r => isBorrowers ? <tr key={r.id}><td><b>{r.name}</b></td><td>{r.identity_number}</td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : isAdmins ? <tr key={r.id}><td><b>{r.full_name}</b></td><td>{r.email}</td><td><Badge tone={r.status === 'disabled' ? 'bad' : ''}>{r.status}</Badge></td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr> : <tr key={r.id}><td><b>{r.reference}</b></td><td>{r.borrowers?.name || '—'}</td><td>{r.inventory_units?.shelves?.code || '—'} #{String(r.inventory_units?.unit_number || '').padStart(3,'0')}</td><td>{new Date(r.borrowed_at).toLocaleDateString()}</td><td>{r.expected_return_at}</td><td><Badge tone={r.returned_at ? 'neutral' : ''}>{r.returned_at ? 'Returned' : 'Borrowed'}</Badge></td></tr>)}</tbody></table>}</section>
}

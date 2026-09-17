import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { fetchShelves, isSupabaseConfigured } from './lib/supabase'

const nav = ['Dashboard','Inventory','Shelves','Borrowers','Transactions','Inventory Checks','Reports']
const admin = ['Operators','Admins','Permissions','Activity Logs','Settings']
const Badge = ({children,tone=''}) => <span className={'badge '+tone}>{children}</span>

export default function App() {
  const [page,setPage] = useState('Dashboard')
  const [mobile,setMobile] = useState(false)
  const [query,setQuery] = useState('')
  const [dbShelves,setDbShelves] = useState([])
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  useEffect(() => { fetchShelves().then(({data,error}) => { if(error) setError(error.message); else setDbShelves(data || []); setLoading(false) }) }, [])
  const shelves = useMemo(() => dbShelves.filter(s => (s.code+' '+s.name+' '+s.item_type).toLowerCase().includes(query.toLowerCase())), [dbShelves,query])
  const units = dbShelves.flatMap(s => s.inventory_units || [])
  const count = status => units.filter(u => u.status === status).length
  const go = name => { setPage(name); setMobile(false) }
  return <div className="app">
    <aside className={mobile ? 'side open' : 'side'}><div className="brand"><b>⌁</b><span><strong>Stockly</strong><small>Inventory system</small></span></div><div className="workspace">● Science Laboratory　⌄</div><label>MAIN MENU</label><nav>{nav.map((n,i)=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>{['⌂','▤','▥','♙','↔','✓','▥'][i]} {n}</button>)}</nav><label>ADMINISTRATION</label><nav>{admin.map(n=><button className={page===n?'active':''} onClick={()=>go(n)} key={n}>⚙ {n}</button>)}</nav></aside>
    <main><header><button className="mobile" onClick={()=>setMobile(!mobile)}>☰</button><div><label>SUPABASE DATABASE</label><h1>{page}</h1><p>{isSupabaseConfigured?'Live data connection':'Environment variables are missing'}</p></div><div className="head"><span>{isSupabaseConfigured?'Connected':'Not connected'}</span></div></header>
    {error && <div className="connection-error"><b>Database connection error:</b> {error}</div>}
    {page==='Dashboard' && <section className="stats">{[['Total units',units.length,'From Supabase','▤'],['Available',count('available'),'Live inventory count','✓'],['Borrowed',count('borrowed'),'Live inventory count','↗'],['Needs attention',units.filter(u=>u.status==='under_maintenance'||u.condition==='damaged').length,'Damaged or maintenance','!']].map((x,i)=><div className="stat" key={x[0]}><i className={'c'+i}>{x[3]}</i><small>{x[0]}</small><strong>{loading?'…':x[1]}</strong><em>{x[2]}</em></div>)}</section>}
    {(page==='Dashboard'||page==='Shelves'||page==='Inventory') && <section className="card page"><div className="cardhead"><div><h2>{page==='Dashboard'?'Shelves from Supabase':page}</h2><p>{loading?'Loading database records…':shelves.length+' shelf records loaded from Supabase'}</p></div><Badge tone={error?'bad':''}>{loading?'Loading':error?'Error':'Connected'}</Badge></div>{page!=='Dashboard'&&<div className="search">⌕ <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search shelves..."/></div>}{!loading&&!error&&!shelves.length&&<div className="empty">No shelves found. Run seed.sql in Supabase, then refresh.</div>}<div className="shelves">{shelves.map(s=><article className="shelf" key={s.id}><div><i>▥</i><Badge>{(s.inventory_units||[]).filter(u=>u.status==='available').length} available</Badge></div><h2>{s.name}</h2><p>{s.code} · {s.item_type}</p><hr/><small><b>{(s.inventory_units||[]).length}</b> total units <span>{(s.inventory_units||[]).filter(u=>u.status==='borrowed').length} borrowed</span></small></article>)}</div></section>}
    {page!=='Dashboard'&&page!=='Shelves'&&page!=='Inventory'&&<section className="card page"><h2>{page}</h2><p className="empty">No records loaded for this tab. Hardcoded data has been removed.</p></section>}
    </main></div>
}

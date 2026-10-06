import { useEffect, useState } from 'react'
import App from './App'
import { supabase } from './lib/supabase'
import './DemoLogin.css'

const demoAccounts = [
  { role: 'Operator', email: 'demo.operator@inventoscan.test', password: 'InventoOperator2026!' },
  { role: 'Admin', email: 'demo.admin@inventoscan.test', password: 'InventoAdmin2026!' },
]

export default function AuthGate() {
  const [session, setSession] = useState(null)
  const [error, setError] = useState(supabase ? '' : 'Supabase is not configured')
  const [loading, setLoading] = useState(Boolean(supabase))
  const [signingIn, setSigningIn] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [fullName, setFullName] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data, error: failure }) => {
      if (failure) { setError(failure.message); setLoading(false) }
      else if (data.session) check(data.session)
      else setLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, current) => {
      // Query account permissions after the auth callback releases its lock.
      if (current) setTimeout(() => check(current), 0)
      else setSession(null)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  async function check(current) {
    try {
      const { data, error: failure } = await supabase.from('user_accounts').select('role,status').eq('email', current.user.email).maybeSingle()
      if (failure) throw failure
      if (data?.status === 'active') setSession(current)
      else { await supabase.auth.signOut(); setSession(null); setError('Your account is pending approval or disabled.') }
    } catch (failure) { setSession(null); setError(failure.message) }
    finally { setLoading(false) }
  }

  async function signIn(credentials, demo = false) {
    if (signingIn) return
    setError('')
    if (!supabase) { setError('Supabase is not configured'); return }
    setSigningIn(true)
    try {
      const { data, error: failure } = await supabase.auth.signInWithPassword(credentials)
      if (failure) throw failure
      if (!data.session) throw new Error('Sign-in did not return a session. Please try again.')
      await check(data.session)
    } catch (failure) {
      setError(demo && failure.code === 'invalid_credentials'
        ? 'Demo account is not ready. Run supabase/demo_accounts.sql in the Supabase SQL Editor, then try again.'
        : failure.message)
    } finally { setSigningIn(false) }
  }

  async function register(event) {
    event.preventDefault(); setError('')
    if (!supabase) { setError('Supabase is not configured'); return }
    setSigningIn(true)
    try {
      const { data, error: signupError } = await supabase.auth.signUp({ email, password })
      if (signupError) throw signupError
      const { error: approvalError } = await supabase.from('account_approvals').insert({ full_name: fullName, email, status: 'pending' })
      if (data.session) await supabase.auth.signOut()
      if (approvalError) throw approvalError
      setRegistering(false); setPassword(''); setError('Account created. An administrator must approve it before you can sign in.')
    } catch (failure) { setError(failure.message) } finally { setSigningIn(false) }
  }

  if (loading) return <div className="login-screen"><div className="login-card">Connecting securely…</div></div>
  if (session) return <App />
  return <div className="login-screen"><div className="login-card">
    <form onSubmit={registering ? register : event => { event.preventDefault(); signIn({ email, password }) }}>
      <div className="login-logo">⌁</div><p className="eyebrow">INVENTORY SYSTEM</p>
      <h2>{registering ? 'Create an account' : 'Welcome back'}</h2>
      <p>{registering ? 'Request access to continue.' : 'Sign in to continue.'}</p>
      {error && <div className="login-error" role="alert">{error}</div>}
      <fieldset className="login-fields" disabled={signingIn}>
        {registering && <label>Full name<input value={fullName} onChange={event => setFullName(event.target.value)} required /></label>}
        <label>Email address<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} minLength="6" required /></label>
        <button className="primary login-button" disabled={!supabase}>{signingIn ? 'Please wait…' : registering ? 'Request operator access' : 'Sign in to VSU InventoScan'}</button>
        <button type="button" className="auth-switch" onClick={() => { setRegistering(!registering); setError('') }}>{registering ? 'Back to sign in' : 'Create an account'}</button>
      </fieldset>
    </form>
    {!registering && <section className="demo-login" aria-label="Demo accounts">
      <h3>Try a demo account</h3><p>Choose a role to sign in automatically.</p>
      <div className="demo-login-options">{demoAccounts.map(account => <button type="button" key={account.role} className="demo-login-button" disabled={signingIn || !supabase} onClick={() => { setEmail(account.email); setPassword(account.password); signIn({ email: account.email, password: account.password }, true) }}>
        <span className="demo-role">{account.role}</span><span className="demo-email">{account.email}</span><span className="demo-action">Open {account.role.toLowerCase()} demo →</span>
      </button>)}</div>
    </section>}
  </div></div>
}

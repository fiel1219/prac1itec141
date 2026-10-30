import { useEffect, useRef, useState } from 'react'
import App from './App'
import { supabase } from './lib/supabase'
import './DemoLogin.css'

const demoAccounts = [
  { role: 'Operator', email: 'demo.operator@inventoscan.test', password: 'InventoOperator2026!' },
  { role: 'System Admin', email: 'demo.admin@inventoscan.test', password: 'InventoAdmin2026!' },
]

export default function AuthGate() {
  const [session, setSession] = useState(null)
  const [error, setError] = useState(supabase ? '' : 'Connection setup required. Please contact an administrator.')
  const [loading, setLoading] = useState(Boolean(supabase))
  const [signingIn, setSigningIn] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [fullName, setFullName] = useState('')
  const authVersion = useRef(0)

  useEffect(() => {
    if (!supabase) return
    const invalidate = () => { authVersion.current++ }
    const initialVersion = ++authVersion.current
    supabase.auth.getSession().then(({ data, error: failure }) => {
      if (initialVersion !== authVersion.current) return
      if (failure) { setError(failure.message); setLoading(false) }
      else if (data.session) check(data.session, initialVersion)
      else setLoading(false)
    }).catch(failure => { if (initialVersion === authVersion.current) { setError(failure.message); setLoading(false) } })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, current) => {
      const version = ++authVersion.current
      // Query account permissions after the auth callback releases its lock.
      if (current) setTimeout(() => { if (version === authVersion.current) check(current, version) }, 0)
      else { setSession(null); setLoading(false) }
    })
    return () => { invalidate(); listener.subscription.unsubscribe() }
  }, [])

  async function check(current, version = ++authVersion.current) {
    try {
      const { data, error: failure } = await supabase.from('user_accounts').select('role,status').eq('email', current.user.email).maybeSingle()
      if (version !== authVersion.current) return
      if (failure) throw failure
      if (data?.status === 'active') { setSession(current); setError('') }
      else { setSession(null); setLoading(false); setError('Your account is pending approval or disabled.'); await supabase.auth.signOut() }
    } catch (failure) { if (version === authVersion.current) { setSession(null); setError(failure.message) } }
    finally { if (version === authVersion.current) setLoading(false) }
  }

  async function signIn(credentials, demo = false) {
    if (signingIn) return
    setError('')
    if (!supabase) { setError('Connection setup required. Please contact an administrator.'); return }
    setSigningIn(true)
    try {
      const { data, error: failure } = await supabase.auth.signInWithPassword(credentials)
      if (failure) throw failure
      if (!data.session) throw new Error('Sign-in did not return a session. Please try again.')
      await check(data.session)
    } catch (failure) {
      setError(demo && failure.code === 'invalid_credentials'
        ? 'Demo account is not ready. Ask an administrator to enable demo access, then try again.'
        : failure.message)
    } finally { setSigningIn(false) }
  }

  async function register(event) {
    event.preventDefault(); setError('')
    if (!supabase) { setError('Connection setup required. Please contact an administrator.'); return }
    if (!fullName.trim()) { setError('Enter your full name.'); return }
    setSigningIn(true)
    try {
      const { data, error: signupError } = await supabase.auth.signUp({ email, password })
      if (signupError) throw signupError
      const { error: approvalError } = await supabase.from('account_approvals').insert({ full_name: fullName.trim(), email: email.trim().toLowerCase(), status: 'pending' })
      if (data.session) await supabase.auth.signOut()
      if (approvalError) throw approvalError
      setRegistering(false); setPassword(''); setShowPassword(false); setError('Account created. An administrator must approve it before you can sign in.')
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
        <div className="password-field">
          <label htmlFor="auth-password">Password</label>
          <div className="password-input">
            <input id="auth-password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} minLength="6" required />
            <button type="button" aria-controls="auth-password" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(visible => !visible)}>{showPassword ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        <button className="primary login-button" disabled={!supabase}>{signingIn ? 'Please wait…' : registering ? 'Request operator access' : 'Sign in to VSU InventoScan'}</button>
        <button type="button" className="auth-switch" onClick={() => { setRegistering(!registering); setShowPassword(false); setError('') }}>{registering ? 'Back to sign in' : 'Create an account'}</button>
      </fieldset>
    </form>
    {!registering && <section className="demo-login" aria-label="Demo accounts">
      <h3>Try a demo account</h3><p>Choose a role to sign in automatically.</p>
      <div className="demo-login-options">{demoAccounts.map(account => <button type="button" key={account.role} className="demo-login-button" disabled={signingIn || !supabase} onClick={() => { setEmail(account.email); setPassword(account.password); setShowPassword(false); signIn({ email: account.email, password: account.password }, true) }}>
        <span className="demo-role">{account.role}</span><span className="demo-email">{account.email}</span><span className="demo-action">Open {account.role.toLowerCase()} demo →</span>
      </button>)}</div>
    </section>}
  </div></div>
}

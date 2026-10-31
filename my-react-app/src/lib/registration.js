export async function registerAccount(client, { fullName, email, password }) {
  // Fail before creating an Auth account if atomic registration is not installed.
  const { data: ready, error: setupError } = await client.rpc('inventory_registration_ready')
  if (setupError?.code === 'PGRST202' || (!setupError && ready !== true)) {
    throw new Error('Registration needs a system update. Please contact your System Admin.')
  }
  if (setupError) throw setupError
  const { data, error } = await client.auth.signUp({
    email: email.trim().toLowerCase(), password,
    options: { data: { full_name: fullName.trim() } },
  })
  if (error) throw error
  // The database trigger creates the pending request with the Auth account.
  // Never insert a second request from the browser.
  if (data.session) await client.auth.signOut()
}

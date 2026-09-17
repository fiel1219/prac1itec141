import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const isSupabaseConfigured = Boolean(supabase)

export async function fetchShelves() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('shelves').select('*, inventory_units(*)').eq('status', 'active').order('code')
}

export async function fetchBorrowers() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('borrowers').select('*').order('name')
}

export async function fetchTransactions() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('transactions').select('*, borrowers(name, identity_number), inventory_units(unit_number, shelf_id, shelves(code, name, item_type))').order('borrowed_at', { ascending: false })
}

export async function fetchAdmins() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('admin_accounts').select('*').order('full_name')
}

export async function fetchUsers() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('user_accounts').select('*').order('full_name')
}

export async function fetchApprovals() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('account_approvals').select('*').eq('status', 'pending').order('created_at', { ascending: false })
}

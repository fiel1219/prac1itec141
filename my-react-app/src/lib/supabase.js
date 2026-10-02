import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const isSupabaseConfigured = Boolean(supabase)

export async function fetchShelves() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  const shelves = [], units = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('shelves').select('*').eq('status', 'active').order('code').range(offset, offset + 499)
    if (error) return { data: null, error }
    shelves.push(...data)
    if (data.length < 500) break
  }
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('inventory_units').select('*').is('retired_at', null).order('id').range(offset, offset + 499)
    if (error) return { data: null, error }
    units.push(...data)
    if (data.length < 500) break
  }
  const grouped = new Map()
  for (const unit of units) {
    if (!grouped.has(unit.shelf_id)) grouped.set(unit.shelf_id, [])
    grouped.get(unit.shelf_id).push(unit)
  }
  return { data: shelves.map(shelf => ({ ...shelf, inventory_units: (grouped.get(shelf.id) || []).sort((a,b) => a.unit_number-b.unit_number) })), error: null }
}

export async function fetchBorrowers() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('borrowers').select('*').order('name')
}

export async function fetchShelfByQR(code) {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  const { data: shelf, error } = await supabase.from('shelves').select('*').eq('qr_value',code.trim()).eq('status','active').maybeSingle()
  if (error || !shelf) return { data: shelf, error }
  const units = []
  for (let offset = 0; ; offset += 500) {
    const { data, error: failure } = await supabase.from('inventory_units').select('*').eq('shelf_id',shelf.id).is('retired_at',null).order('unit_number').range(offset,offset+499)
    if (failure) return { data: null, error: failure }
    units.push(...data)
    if (data.length < 500) break
  }
  return { data: { ...shelf, inventory_units: units }, error: null }
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

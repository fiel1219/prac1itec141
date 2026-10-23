import { createClient } from '@supabase/supabase-js'
import { loadInventoryUnits, loadTransactions, inventoryMigrationRequired, inventoryItemNamesRequired } from './inventoryData'
import { resolveInventoryQR } from './inventoryQR'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const isSupabaseConfigured = Boolean(supabase)

export async function fetchShelves() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  const shelves = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('shelves').select('*').eq('status', 'active').order('code').range(offset, offset + 499)
    if (error) return { data: null, error }
    shelves.push(...data)
    if (data.length < 500) break
  }
  const { data: units, error: unitError } = await loadInventoryUnits(supabase)
  if (unitError) return { data: null, error: unitError }
  const { required, unitActionsRequired, permanentDeleteRequired, error: schemaError } = await inventoryMigrationRequired(supabase)
  if (schemaError) return { data: null, error: schemaError }
  const { required: itemNamesRequired, error: itemNamesError } = await inventoryItemNamesRequired(supabase)
  if (itemNamesError) return { data: null, error: itemNamesError }
  const grouped = new Map()
  for (const unit of units) {
    if (!grouped.has(unit.shelf_id)) grouped.set(unit.shelf_id, [])
    grouped.get(unit.shelf_id).push(unit)
  }
  return { data: shelves.map(shelf => ({ ...shelf, inventory_units: (grouped.get(shelf.id) || []).sort((a,b) => a.unit_number-b.unit_number) })), error: null, migrationRequired: required, unitActionsRequired, permanentDeleteRequired, itemNamesRequired }
}

export async function fetchBorrowers() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('borrowers').select('*').order('name')
}

export async function fetchInventoryByQR(code) {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return resolveInventoryQR(supabase, code)
}

export async function fetchTransactions(activeOnly = false) {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return loadTransactions(supabase, activeOnly)
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

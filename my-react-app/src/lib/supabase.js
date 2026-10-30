import { createClient } from '@supabase/supabase-js'
import { loadTransactions, loadShelfInventory } from './inventoryData'
import { loadPagedRows } from './queryData'
import { resolveInventoryQR } from './inventoryQR'
import { loadLaboratories } from './laboratories'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const isSupabaseConfigured = Boolean(supabase)

export async function fetchLaboratories() {
  if (!supabase) return { data:null,error:new Error('Connection setup required. Please contact an administrator.') }
  return loadLaboratories(supabase)
}

export async function fetchShelves() {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return loadShelfInventory(supabase)
}

export async function fetchBorrowers() {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return loadPagedRows(supabase, 'borrowers', { orders: [['name'], ['id']] })
}

export async function fetchInventoryByQR(code) {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return resolveInventoryQR(supabase, code)
}

export async function fetchTransactions(activeOnly = false, laboratoryId = null) {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return loadTransactions(supabase, activeOnly, laboratoryId)
}

export async function fetchUsers() {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return loadPagedRows(supabase, 'user_accounts', { orders: [['full_name'], ['id']] })
}

export async function fetchApprovals() {
  if (!supabase) return { data: null, error: new Error('Connection setup required. Please contact an administrator.') }
  return loadPagedRows(supabase, 'account_approvals', { orders: [['created_at', { ascending: false }], ['id']], filters: [['status', 'pending']] })
}

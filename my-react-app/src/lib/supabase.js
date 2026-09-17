import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const isSupabaseConfigured = Boolean(supabase)

export async function fetchShelves() {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured') }
  return supabase.from('shelves').select('*, inventory_units(*)').eq('status', 'active').order('code')
}

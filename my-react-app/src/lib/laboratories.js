const setupErrors = ['42703','42P01','PGRST204','PGRST205']
const legacyLaboratory = { id:'legacy', name:'Science Laboratory', description:'' }

export async function loadLaboratories(client) {
  const records = []
  for (let offset=0; ; offset+=500) {
    const { data,error } = await client.from('laboratories').select('*').order('name').order('id').range(offset,offset+499)
    if (error) return setupErrors.includes(error.code)
      ? { data:[legacyLaboratory], setupRequired:true, error:null }
      : { data:null, error }
    records.push(...data)
    if (data.length<500) break
  }
  const checks = await Promise.all(['shelves','transactions','stock_movements'].map(table => client.from(table).select('laboratory_id').limit(0)))
  for (const { error } of checks) {
    if (!error) continue
    if (setupErrors.includes(error.code)) return { data:[legacyLaboratory], setupRequired:true, error:null }
    return { data:null,error }
  }
  return { data:records,setupRequired:false,error:null }
}

export function storedLaboratory() {
  try { return localStorage.getItem('inventoscan.laboratory') || '' } catch { return '' }
}

export function rememberLaboratory(id) {
  try {
    if (id) localStorage.setItem('inventoscan.laboratory',id)
    else localStorage.removeItem('inventoscan.laboratory')
  } catch { /* The selector also works when browser storage is unavailable. */ }
}

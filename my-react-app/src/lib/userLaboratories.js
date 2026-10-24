export const laboratoryRoles = ['Laboratory Admin', 'Laboratory Operator']

export async function loadUserLaboratories(client, userId) {
  const assignments = []
  for (let offset = 0; ; offset += 500) {
    let request = client.from('laboratory_memberships').select('user_id,laboratory_id,role').order('user_id').order('laboratory_id')
    if (userId) request = request.eq('user_id', userId)
    const { data, error } = await request.range(offset, offset + 499)
    if (error) {
      if (['42P01', 'PGRST205'].includes(error.code)) return { data: [], setupRequired: true, error: null }
      return { data: null, error }
    }
    assignments.push(...data)
    if (data.length < 500) return { data: assignments, setupRequired: false, error: null }
  }
}

export function userRoleLabel(user, assignments, laboratoryId) {
  if (user?.role === 'Admin') return 'System Admin'
  return assignments.find(row => row.user_id === user?.id && row.laboratory_id === laboratoryId)?.role || 'No laboratory assignment'
}

export function filterUsers(users, assignments, query, role, laboratoryId) {
  const search = query.trim().toLowerCase()
  return users.filter(user => {
    if (!`${user.full_name || ''} ${user.email || ''}`.toLowerCase().includes(search)) return false
    const memberships = assignments.filter(row => row.user_id === user.id)
    if (role === 'System Admin') return user.role === 'Admin' && (!laboratoryId || memberships.some(row => row.laboratory_id === laboratoryId))
    if (role === 'Unassigned') return user.role !== 'Admin' && !memberships.length && !laboratoryId
    return role === 'All'
      ? !laboratoryId || memberships.some(row => row.laboratory_id === laboratoryId)
      : memberships.some(row => row.role === role && (!laboratoryId || row.laboratory_id === laboratoryId))
  })
}

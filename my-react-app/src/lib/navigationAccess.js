const sharedPages = ['Dashboard', 'Shelves', 'Items', 'Transaction History', 'Reports']

export function navigationPages(user, assignments, laboratoryId) {
  if (user?.status !== 'active') return []
  if (user.role === 'Admin') return [...sharedPages, 'Users', 'Admin Approvals']
  if (user.role !== 'Operator' || !laboratoryId) return ['Dashboard']
  const role = assignments.find(row => row.user_id === user.id && row.laboratory_id === laboratoryId)?.role
  if (role === 'Laboratory Admin') return [...sharedPages, 'Inventory Checks', 'Scan QR', 'Returns']
  if (role === 'Laboratory Operator') return [...sharedPages, 'Scan QR', 'Returns']
  return ['Dashboard']
}

export function canManageLaboratoryInventory(user, assignments, laboratoryId) {
  if (user?.status !== 'active' || !laboratoryId) return false
  return user.role === 'Admin' || (user.role === 'Operator' && assignments.some(row =>
    row.user_id === user.id && row.laboratory_id === laboratoryId && row.role === 'Laboratory Admin'))
}

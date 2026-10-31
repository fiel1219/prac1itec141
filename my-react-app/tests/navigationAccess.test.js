import { test } from 'node:test'
import assert from 'node:assert/strict'
import { navigationPages, canManageLaboratoryInventory } from '../src/lib/navigationAccess.js'

test('navigation matches the system and selected laboratory roles without combining assignments', () => {
  const user = { id: 'u', status: 'active', role: 'Operator' }
  const memberships = [
    { user_id: 'u', laboratory_id: 'science', role: 'Laboratory Admin' },
    { user_id: 'u', laboratory_id: 'computer', role: 'Laboratory Operator' },
    { user_id: 'other', laboratory_id: 'chemistry', role: 'Laboratory Admin' },
  ]
  const common = ['Dashboard', 'Shelves', 'Items', 'Transaction History', 'Reports']
  assert.deepEqual(navigationPages({ ...user, role: 'Admin' }, memberships, 'science'), [...common, 'Users', 'Admin Approvals'])
  assert.deepEqual(navigationPages({ ...user, role: 'Admin' }, [], null), [...common, 'Users', 'Admin Approvals'])
  assert.deepEqual(navigationPages(user, memberships, 'science'), [...common, 'Inventory Checks', 'Scan QR', 'Returns'])
  assert.deepEqual(navigationPages(user, memberships, 'computer'), [...common, 'Scan QR', 'Returns'])
  for (const id of ['chemistry', 'unassigned', null]) assert.deepEqual(navigationPages(user, memberships, id), ['Dashboard'])
  assert.deepEqual(navigationPages(user, [{ ...memberships[0], role: 'Unknown' }], 'science'), ['Dashboard'])
  assert.deepEqual(navigationPages({ ...user, role: 'Unknown' }, memberships, 'science'), ['Dashboard'])
  assert.deepEqual(navigationPages({ ...user, status: 'disabled' }, memberships, 'science'), [])
  assert.deepEqual(navigationPages({ ...user, role: 'Admin', status: 'disabled' }, memberships, 'science'), [])
  assert.deepEqual(navigationPages(null, memberships, 'science'), [])
})

test('inventory management is limited to active System Admins and the selected laboratory Admin', () => {
  const user = { id:'u',status:'active',role:'Operator' }
  const assignments = [{user_id:'u',laboratory_id:'science',role:'Laboratory Admin'}, {user_id:'u',laboratory_id:'computer',role:'Laboratory Operator'}]
  assert.equal(canManageLaboratoryInventory(user,assignments,'science'),true)
  assert.equal(canManageLaboratoryInventory(user,assignments,'computer'),false)
  assert.equal(canManageLaboratoryInventory(user,assignments,'foreign'),false)
  assert.equal(canManageLaboratoryInventory({...user,role:'Admin'},[],'computer'),true)
  assert.equal(canManageLaboratoryInventory({...user,status:'disabled'},assignments,'science'),false)
  assert.equal(canManageLaboratoryInventory({...user,role:'Admin',status:'disabled'},assignments,'science'),false)
  assert.equal(canManageLaboratoryInventory({...user,role:'Unknown'},assignments,'science'),false)
  assert.equal(canManageLaboratoryInventory(user,[{...assignments[0],user_id:'other'}],'science'),false)
  assert.equal(canManageLaboratoryInventory(user,assignments,null),false)
  assert.equal(canManageLaboratoryInventory(null,assignments,'science'),false)
})

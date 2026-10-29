const ALL = ['ADMIN', 'PURCHASER', 'WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER'];

const PERMISSIONS = {
  'users.manage': ['ADMIN'],
  'catalog.manage': ['ADMIN', 'PURCHASER'],
  'suppliers.manage': ['ADMIN', 'PURCHASER'],
  'warehouses.manage': ['ADMIN', 'WAREHOUSE_MANAGER'],
  'stock.view': ALL,
  'po.manage': ['ADMIN', 'PURCHASER'],
  'gr.create': ['ADMIN', 'WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER'],
  'gr.approve': ['ADMIN', 'WAREHOUSE_MANAGER'],
  'issues.manage': ['ADMIN', 'PURCHASER'],
  'rr.create': ['ADMIN', 'WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER'],
  'rr.approve': ['ADMIN', 'WAREHOUSE_MANAGER'],
  'audit.view': ['ADMIN', 'WAREHOUSE_MANAGER'],
};

function can(user, perm) {
  if (!user) return false;
  const roles = PERMISSIONS[perm];
  if (!roles) throw new Error(`Quyền không tồn tại: ${perm}`);
  return roles.includes(user.role);
}

module.exports = { can, PERMISSIONS };

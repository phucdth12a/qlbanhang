const ALL = ['ADMIN', 'PURCHASER', 'SALES', 'WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER'];
const WH = ['ADMIN', 'WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER'];
const WH_APPROVE = ['ADMIN', 'WAREHOUSE_MANAGER'];

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
  'customers.manage': ['ADMIN', 'SALES'],
  'so.manage': ['ADMIN', 'SALES'],
  'gi.create': WH,
  'gi.approve': WH_APPROVE,
  'tr.create': WH,
  'tr.approve': WH_APPROVE,
  'adj.create': WH,
  'adj.approve': WH_APPROVE,
};

function can(user, perm) {
  if (!user) return false;
  const roles = PERMISSIONS[perm];
  if (!roles) throw new Error(`Quyền không tồn tại: ${perm}`);
  return roles.includes(user.role);
}

module.exports = { can, PERMISSIONS };

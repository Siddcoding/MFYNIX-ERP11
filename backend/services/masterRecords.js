/**
 * Governed master records: read and write the configured customer, vendor,
 * material and payment-terms masters through the Master Data Control rules.
 *
 * The master_field_value store is the source of truth for all configured
 * fields. A bridge keeps the columns the rest of the ERP depends on in sync on
 * the existing Customer/Supplier/Item/PaymentTerm rows, so nothing downstream
 * (sales, GST, reports) has to change.
 */
const db = require('../db');
const mc = require('./masterControl');
const { logAudit } = require('../routes/auth');

const ANCHOR = {
  customer: { table: 'Customer', id: 'CustomerID', nameCol: 'CustomerName', codeField: 'cust_code', codePrefix: 'CUST' },
  vendor: { table: 'Supplier', id: 'SupplierID', nameCol: 'SupplierName', codeField: 'vend_code', codePrefix: 'VEND' },
  material: { table: 'Item', id: 'ItemID', nameCol: 'ItemName', codeField: 'mat_code', codePrefix: 'MAT' },
  payment_terms: { table: 'PaymentTerm', id: 'PaymentTermID', nameCol: 'Description', codeField: 'pt_code', codePrefix: 'PT' }
};

// field_id -> existing column, per master. Fields not listed live only in the
// field-value store. status is special-cased to IsActive (Active/Inactive<->1/0).
const BRIDGE = {
  customer: {
    cust_code: 'CustomerCode', cust_name: 'CustomerName', cust_type: 'PartyType', gstin: 'GSTIN', pan: 'PAN',
    cust_group: 'CustomerGroup', home_branch: 'BranchID', contact_name: 'ContactPerson', mobile: 'Mobile',
    email: 'Email', bill_address: 'AddressLine1', bill_address2: 'AddressLine2', bill_city: 'City', bill_state: 'State', pay_term: 'PaymentTermID',
    credit_limit: 'CreditLimit', dunning_proc: 'DunningProcedureID', dunning_block: 'DunningBlock',
    dunning_block_reason: 'DunningBlockReason', opening_balance: 'OpeningBalance', portal_access: 'PortalEnabled'
  },
  vendor: {
    vend_name: 'SupplierName', vend_type: 'PartyType', gstin: 'GSTIN', pan: 'PAN', contact_name: 'ContactPerson',
    mobile: 'Mobile', email: 'Email', address: 'AddressLine1', address2: 'AddressLine2', state: 'State', pay_term: 'PaymentTermID',
    bank_account: 'BankAccount', bank_ifsc: 'BankIFSC', payment_block: 'PaymentBlock', opening_balance: 'OpeningBalance'
  },
  material: {
    mat_code: 'ItemCode', mat_name: 'ItemName', mat_type: 'MaterialType', category: 'Category', barcode: 'Barcode',
    hsn_sac: 'HSN', gst_rate: 'GSTRate', base_unit: 'Unit', purchase_rate: 'PurchaseRate', sale_rate: 'SaleRate',
    reorder_level: 'ReorderLevel', pref_vendor: 'PreferredVendorID', shelf_life: 'ShelfLifeMonths'
  },
  payment_terms: {
    pt_code: 'Code', pt_desc: 'Description', pt_baseline: 'BaselineDate', pt_net_days: 'NetDays'
  }
};
// Columns that are booleans stored as 0/1 when bridged from a Yes/No field.
const BOOL_COLS = { DunningBlock: 1, PortalEnabled: 1, PaymentBlock: 1 };

function truthy(v) { return v === true || v === 1 || v === 'Yes' || v === 'yes' || v === '1' || v === 'true'; }
function toBridge(col, val) {
  if (BOOL_COLS[col]) return truthy(val) ? 1 : 0;
  return val === '' ? null : val;
}
function fromBridge(col, val) {
  if (BOOL_COLS[col]) return val ? 'Yes' : 'No';
  return val == null ? '' : String(val);
}

// ---- used state (layer 4) -------------------------------------------------
const USAGE = {
  customer: [['SalesHeader', 'CustomerID'], ['NoteHeader', 'PartyID']],
  vendor: [['PurchaseHeader', 'SupplierID'], ['NoteHeader', 'PartyID']],
  material: [['SalesDetail', 'ItemID'], ['PurchaseDetail', 'ItemID'], ['StockLedger', 'ItemID']],
  payment_terms: [['SalesHeader', 'PaymentTermID']]
};
function recordUsed(master, recordId) {
  for (const [t, col] of (USAGE[master] || [])) {
    try { if (db.prepare(`SELECT 1 FROM ${t} WHERE ${col} = ? LIMIT 1`).get(recordId)) return true; }
    catch (e) { /* table may not exist in older DBs */ }
  }
  return false;
}

// ---- option sources for list fields ---------------------------------------
const STATIC_OPTIONS = {
  cust_type: ['Registered business', 'Unregistered', 'Export', 'SEZ'],
  vend_type: ['Registered', 'Unregistered', 'Composition', 'Import'],
  mat_type: ['Goods', 'Service'],
  tax_category: ['Taxable', 'Exempt', 'Nil-rated', 'Non-GST'],
  gst_rate: ['0', '0.25', '3', '5', '12', '18', '28'],
  base_unit: ['PCS', 'KG', 'GM', 'LTR', 'ML', 'MTR', 'BOX', 'PKT', 'DOZ', 'SET', 'UNIT'],
  tracking: ['None', 'Batch', 'Batch with expiry', 'Serial'],
  invoicing_mode: ['Per delivery', 'Consolidated daily', 'Consolidated weekly', 'Consolidated monthly'],
  tds_section: ['194C', '194J', '194H', '194I', '194Q', '206C'],
  pt_applies: ['Customer', 'Vendor', 'Both'],
  pt_baseline: ['Document date', 'Delivery date', 'End of month'],
  status: ['Active', 'Inactive']
};
function options(companyId, master) {
  const o = {};
  const defs = mc.fieldsFor(master).filter(f => f.FieldType === 'List');
  for (const f of defs) {
    const id = f.FieldID;
    if (STATIC_OPTIONS[id]) { o[id] = STATIC_OPTIONS[id].map(v => ({ value: v, label: v })); continue; }
    if (id === 'home_branch') o[id] = db.prepare('SELECT BranchID v, BranchName l FROM Branch WHERE CompanyID = ?').all(companyId).map(r => ({ value: String(r.v), label: r.l }));
    else if (id === 'pay_term') o[id] = db.prepare('SELECT PaymentTermID v, Code c, Description d FROM PaymentTerm WHERE CompanyID = ? AND IsActive = 1').all(companyId).map(r => ({ value: String(r.v), label: `${r.c}${r.d ? ' — ' + r.d : ''}` }));
    else if (id === 'bill_state' || id === 'state') { const { STATE_CODES, stateNameForCode } = require('./tax'); const seen = {}; const out = []; Object.entries(STATE_CODES).forEach(([n, c]) => { if (seen[c]) return; seen[c] = 1; out.push({ value: stateNameForCode(c), label: `${c} — ${stateNameForCode(c)}` }); }); o[id] = out; }
    else if (id === 'dunning_proc') o[id] = tryList('SELECT ProcedureID v, Name l FROM DunningProcedure WHERE CompanyID = ? AND IsActive = 1', companyId);
    else if (id === 'default_account') o[id] = tryList("SELECT AccountID v, AccountName l FROM ChartOfAccounts WHERE CompanyID = ? AND AccountType IN ('Expense','Asset') AND IsActive = 1", companyId);
    else if (id === 'pref_vendor') o[id] = db.prepare('SELECT SupplierID v, SupplierName l FROM Supplier WHERE CompanyID = ? AND IsActive = 1').all(companyId).map(r => ({ value: String(r.v), label: r.l }));
    else if (id === 'salesperson') o[id] = tryList("SELECT UserID v, FullName l FROM Users WHERE CompanyID = ? AND Status='Active'", companyId);
    else if (id === 'cust_group') o[id] = distinctVals('Customer', 'CustomerGroup', companyId);
    else if (id === 'category') o[id] = distinctVals('Item', 'Category', companyId);
    else if (id === 'price_list') o[id] = [];
    else o[id] = [];
  }
  return o;
}
function tryList(sql, companyId) { try { return db.prepare(sql).all(companyId).map(r => ({ value: String(r.v), label: r.l })); } catch (e) { return []; } }
function distinctVals(table, col, companyId) { try { return db.prepare(`SELECT DISTINCT ${col} v FROM ${table} WHERE CompanyID = ? AND ${col} IS NOT NULL AND ${col} <> ''`).all(companyId).map(r => ({ value: r.v, label: r.v })); } catch (e) { return []; } }

// ---- read stored values (KV first, backfilled from core columns) ----------
function storedValues(companyId, master, recordId) {
  const out = {};
  const anchor = ANCHOR[master];
  const row = db.prepare(`SELECT * FROM ${anchor.table} WHERE ${anchor.id} = ? AND CompanyID = ?`).get(recordId, companyId);
  // Backfill from bridged columns first (covers records made before the KV store).
  if (row) {
    for (const [fid, col] of Object.entries(BRIDGE[master])) out[fid] = fromBridge(col, row[col]);
    out.status = row.IsActive === 0 ? 'Inactive' : 'Active';
  }
  // KV store overrides / adds the rest.
  db.prepare('SELECT FieldID, Value FROM master_field_value WHERE CompanyID = ? AND Master = ? AND RecordID = ?').all(companyId, master, recordId)
    .forEach(r => { out[r.FieldID] = r.Value == null ? '' : r.Value; });
  return out;
}

function writeValues(companyId, master, recordId, values) {
  const up = db.prepare(`INSERT INTO master_field_value (CompanyID, Master, RecordID, FieldID, Value, UpdatedAt)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(CompanyID, Master, RecordID, FieldID) DO UPDATE SET Value = excluded.Value, UpdatedAt = datetime('now')`);
  const tx = db.transaction(() => { for (const [fid, v] of Object.entries(values)) up.run(companyId, master, recordId, fid, v == null ? null : String(v)); });
  tx();
}

// Write one field through to its bridged core column, if it has one.
function bridgeOne(companyId, master, recordId, fieldId, value) {
  const anchor = ANCHOR[master];
  if (fieldId === 'status') { db.prepare(`UPDATE ${anchor.table} SET IsActive = ? WHERE ${anchor.id} = ? AND CompanyID = ?`).run(/^active$/i.test(String(value)) ? 1 : 0, recordId, companyId); return true; }
  const col = BRIDGE[master][fieldId];
  if (!col) return false;
  try { db.prepare(`UPDATE ${anchor.table} SET ${col} = ? WHERE ${anchor.id} = ? AND CompanyID = ?`).run(toBridge(col, value), recordId, companyId); return true; }
  catch (e) { return false; }
}

// ---- list / get -----------------------------------------------------------
function listRecords(companyId, master, { includeInactive = false } = {}) {
  const a = ANCHOR[master];
  const rows = db.prepare(`SELECT * FROM ${a.table} WHERE CompanyID = ?${includeInactive ? '' : ' AND IsActive = 1'} ORDER BY ${a.id} DESC`).all(companyId);
  return rows.map(r => {
    const v = storedValues(companyId, master, r[a.id]);
    return { recordId: r[a.id], used: recordUsed(master, r[a.id]), status: r.IsActive === 0 ? 'Inactive' : 'Active', values: v };
  });
}

function getRecord(user, companyId, master, recordId) {
  const values = storedValues(companyId, master, recordId);
  // Mask sensitive fields this role may not see in full.
  const masked = {};
  for (const [fid, val] of Object.entries(values)) {
    masked[fid] = mc.canViewFull(user.role, fid) ? val : mc.maskValue(fid, val);
  }
  return { recordId, used: recordUsed(master, recordId), values: masked };
}

// ---- create ---------------------------------------------------------------
function nextCode(companyId, master) {
  const a = ANCHOR[master];
  const n = (db.prepare(`SELECT COUNT(*) c FROM ${a.table} WHERE CompanyID = ?`).get(companyId).c || 0) + 1;
  return `${a.codePrefix}-${String(n).padStart(4, '0')}`;
}

function createRecord(user, companyId, master, values, ip) {
  const check = mc.checkSave(user, companyId, master, 'create', { values, stored: {}, recordUsed: false });
  if (check.errors.length) return { errors: check.errors };

  const a = ANCHOR[master];
  // Auto-generate the code if the field is system-generated and none was given.
  const codeDef = mc.fieldDef(master, a.codeField);
  if (codeDef && (!values[a.codeField] || String(values[a.codeField]).trim() === '')) {
    values = { ...values, [a.codeField]: nextCode(companyId, master) };
  }

  // Build the core-table insert from bridged fields + required columns.
  const cols = { CompanyID: companyId };
  for (const [fid, col] of Object.entries(BRIDGE[master])) {
    if (values[fid] !== undefined) cols[col] = toBridge(col, values[fid]);
  }
  if (!cols[a.nameCol]) cols[a.nameCol] = values[master === 'payment_terms' ? 'pt_desc' : a.codeField] || 'New';
  // PaymentTerm has NOT NULL BaselineDate/NetDays/Code.
  if (master === 'payment_terms') { if (cols.BaselineDate == null) cols.BaselineDate = 'Document date'; if (cols.NetDays == null) cols.NetDays = 0; if (!cols.Code) cols.Code = values.pt_code || nextCode(companyId, master); }
  cols.IsActive = 1;

  const keys = Object.keys(cols);
  const recordId = db.prepare(`INSERT INTO ${a.table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => cols[k])).lastInsertRowid;

  writeValues(companyId, master, recordId, values);
  logAudit({ companyId, userId: user.userId, action: `CREATE_${master.toUpperCase()}_GOVERNED`, entityType: master, entityId: recordId, details: values[a.nameCol in values ? a.nameCol : (master === 'customer' ? 'cust_name' : master === 'vendor' ? 'vend_name' : master === 'material' ? 'mat_name' : 'pt_desc')] || '', ip });
  return { recordId, code: values[a.codeField] };
}

// ---- edit -----------------------------------------------------------------
function editRecord(user, companyId, master, recordId, values, ip) {
  const stored = storedValues(companyId, master, recordId);
  const used = recordUsed(master, recordId);
  const check = mc.checkSave(user, companyId, master, 'edit', { values, stored, recordUsed: used });
  if (check.errors.length) return { errors: check.errors };

  // Apply the straightforward changes (KV + bridge).
  if (Object.keys(check.applied).length) {
    writeValues(companyId, master, recordId, check.applied);
    for (const [fid, v] of Object.entries(check.applied)) {
      bridgeOne(companyId, master, recordId, fid, v);
      auditField(companyId, user, master, recordId, fid, stored[fid], v, ip);
    }
  }

  // Route approval fields to pending changes (one per field).
  const pending = [];
  for (const ap of check.approvals) {
    const open = db.prepare("SELECT 1 FROM master_pending_change WHERE CompanyID = ? AND Master = ? AND RecordID = ? AND FieldID = ? AND Status = 'pending'").get(companyId, master, recordId, ap.field);
    if (open) { pending.push({ field: ap.field, skipped: 'already pending' }); continue; }
    db.prepare(`INSERT INTO master_pending_change (CompanyID, Master, RecordID, FieldID, Label, OldValue, NewValue, RequestedBy)
      VALUES (?,?,?,?,?,?,?,?)`).run(companyId, master, recordId, ap.field, ap.label, ap.oldValue, ap.newValue, user.userId);
    pending.push({ field: ap.field, label: ap.label, newValue: ap.newValue });
  }
  return { recordId, appliedCount: Object.keys(check.applied).length, pending };
}

// Apply an approved pending change to both stores (called from the route).
function applyApprovedValue(companyId, master, recordId, fieldId, value) {
  writeValues(companyId, master, recordId, { [fieldId]: value });
  return bridgeOne(companyId, master, recordId, fieldId, value);
}

function auditField(companyId, user, master, recordId, fid, oldV, newV, ip) {
  const def = mc.fieldDef(master, fid);
  if (def && !def.Audit) return;
  logAudit({ companyId, userId: user.userId, action: `UPDATE_${master.toUpperCase()}_FIELD`, entityType: master, entityId: recordId, details: `${fid}: ${oldV == null ? '' : oldV} -> ${newV == null ? '' : newV}`, ip });
}

module.exports = { ANCHOR, options, recordUsed, storedValues, listRecords, getRecord, createRecord, editRecord, applyApprovedValue };

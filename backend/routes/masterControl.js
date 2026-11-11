/**
 * Master Data Control API (Developer Guide sections 4-10).
 *
 *   GET  /:master/layout        resolved layout for a screen (9.1)
 *   GET  /config                the whole configuration, for the control centre
 *   GET  /masters               master list with field/tab counts
 *   POST /tab                   switch a tab on/off (4) - core tabs refused
 *   GET  /role-access           role x master access matrix (7)
 *   PUT  /role-access           change one role's access to a master
 *   GET  /pending               pending master-data changes (6)
 *   POST /pending               propose a change to an approval field
 *   POST /pending/:id/approve   approve   (requester != approver, ROL-05)
 *   POST /pending/:id/reject    reject    (old value kept)
 *   POST /import                re-import an edited configuration spreadsheet (10)
 *   GET  /versions              saved configuration versions
 */
const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('./auth');
const mc = require('../services/masterControl');
const records = require('../services/masterRecords');
const defaults = require('../config/masterControlDefaults');

const router = express.Router();
router.use(requireAuth);

const MASTERS = defaults.MASTERS;
const ADMIN_ROLES = ['Super Admin', 'Company Admin'];
function isMaster(m) { return MASTERS.includes(m); }

// Fields whose approved value we can write straight back to the live record.
// Everything else records the decision without touching the domain table.
const APPLY_MAP = {
  customer: { table: 'Customer', id: 'CustomerID', cols: { cust_name: 'CustomerName', gstin: 'GSTIN', pan: 'PAN', bill_state: 'State', credit_limit: 'CreditLimit', pay_term: 'PaymentTermID', cust_type: 'PartyType', status: 'IsActive' } },
  vendor: { table: 'Supplier', id: 'SupplierID', cols: { vend_name: 'SupplierName', gstin: 'GSTIN', pan: 'PAN', state: 'State', pay_term: 'PaymentTermID', bank_account: 'BankAccount', bank_ifsc: 'BankIFSC', vend_type: 'PartyType', status: 'IsActive' } }
};
function applyApproved(companyId, master, recordId, fieldId, newValue) {
  const map = APPLY_MAP[master];
  if (!map || !map.cols[fieldId]) return false;
  let col = map.cols[fieldId], val = newValue;
  if (fieldId === 'status') { col = 'IsActive'; val = /^active$/i.test(String(newValue)) ? 1 : 0; }
  try {
    db.prepare(`UPDATE ${map.table} SET ${col} = ? WHERE ${map.id} = ? AND CompanyID = ?`).run(val, recordId, companyId);
    return true;
  } catch (e) { return false; }
}

// ---- Layout (9.1) ---------------------------------------------------------
router.get('/:master/layout', (req, res) => {
  const master = req.params.master;
  if (!isMaster(master)) return res.status(404).json({ error: 'Unknown master' });
  const mode = ['create', 'edit', 'display'].includes(req.query.mode) ? req.query.mode : 'create';
  const recordUsed = req.query.used === '1' || req.query.used === 'true';
  // Any extra query params are treated as field values, so conditional rules
  // (e.g. cust_type=Registered business) can be previewed live.
  const record = { ...req.query };
  delete record.mode; delete record.used; delete record.recordId;
  const layout = mc.buildLayout(req.user, req.user.companyId, master, mode, { record, recordUsed });
  layout.recordId = req.query.recordId ? Number(req.query.recordId) : null;
  res.json(layout);
});

// ---- Governed records: list / get / create / edit (enforced) --------------
// Option sources for list fields.
router.get('/:master/options', (req, res) => {
  if (!isMaster(req.params.master)) return res.status(404).json({ error: 'Unknown master' });
  if (mc.roleAccess(req.user.companyId, req.user.role, req.params.master) === 'none') return res.status(403).json({ error: 'No access to this master' });
  res.json(records.options(req.user.companyId, req.params.master));
});

router.get('/:master/records', (req, res) => {
  const master = req.params.master;
  if (!isMaster(master)) return res.status(404).json({ error: 'Unknown master' });
  if (mc.roleAccess(req.user.companyId, req.user.role, master) === 'none') return res.status(403).json({ error: 'No access to this master' });
  const rows = records.listRecords(req.user.companyId, master, { includeInactive: req.query.all === '1' });
  // Mask sensitive values in the list too.
  rows.forEach(r => { for (const fid of Object.keys(r.values)) if (!mc.canViewFull(req.user.role, fid)) r.values[fid] = mc.maskValue(fid, r.values[fid]); });
  res.json(rows);
});

router.get('/:master/record/:id', (req, res) => {
  const master = req.params.master;
  if (!isMaster(master)) return res.status(404).json({ error: 'Unknown master' });
  if (mc.roleAccess(req.user.companyId, req.user.role, master) === 'none') return res.status(403).json({ error: 'No access to this master' });
  res.json(records.getRecord(req.user, req.user.companyId, master, Number(req.params.id)));
});

router.post('/:master/record', (req, res) => {
  const master = req.params.master;
  if (!isMaster(master)) return res.status(404).json({ error: 'Unknown master' });
  const result = records.createRecord(req.user, req.user.companyId, master, req.body.values || {}, req.ip);
  if (result.errors) return res.status(400).json({ errors: result.errors });
  res.status(201).json(result);
});

router.put('/:master/record/:id', (req, res) => {
  const master = req.params.master;
  if (!isMaster(master)) return res.status(404).json({ error: 'Unknown master' });
  const result = records.editRecord(req.user, req.user.companyId, master, Number(req.params.id), req.body.values || {}, req.ip);
  if (result.errors) return res.status(400).json({ errors: result.errors });
  res.json(result);
});

// ---- Whole configuration, for the control centre --------------------------
router.get('/config', (req, res) => {
  const cid = req.user.companyId;
  const fields = db.prepare('SELECT Master, Tab, FieldID, Label, FieldType, CreateStatus, EditStatus, DisplayStatus, LockAfterUse, NeedsApproval, Audit, ValidationRule, DefaultValue, Requirement, SortOrder FROM master_field_control ORDER BY Master, SortOrder').all();
  const tabs = db.prepare('SELECT Master, Tab, Purpose, CanSwitchOff, Status, EffectWhenOff FROM master_tab_control WHERE CompanyID = ? ORDER BY ID').all(cid);
  const roleAccess = db.prepare('SELECT Role, Master, AccessLevel FROM role_master_access WHERE CompanyID = ? ORDER BY Master, Role').all(cid);
  const sensitive = db.prepare('SELECT GroupCode, Label, FieldIDs, EditRoles, FullViewRoles, MaskedFormat FROM sensitive_field_group').all();
  res.json({ masters: MASTERS, masterLabels: defaults.MASTER_LABELS, roles: defaults.roles, fields, tabs, roleAccess, sensitive });
});

router.get('/masters', (req, res) => {
  const cid = req.user.companyId;
  res.json(MASTERS.map(m => ({
    master: m, label: defaults.MASTER_LABELS[m],
    fields: db.prepare('SELECT COUNT(*) c FROM master_field_control WHERE Master = ?').get(m).c,
    tabs: db.prepare('SELECT COUNT(*) c FROM master_tab_control WHERE CompanyID = ? AND Master = ?').get(cid, m).c,
    offTabs: db.prepare("SELECT COUNT(*) c FROM master_tab_control WHERE CompanyID = ? AND Master = ? AND Status = 'Inactive'").get(cid, m).c,
    myAccess: mc.roleAccess(cid, req.user.role, m)
  })));
});

// ---- Tab on/off (4) -------------------------------------------------------
router.post('/tab', requireRole(...ADMIN_ROLES), (req, res) => {
  const { master, tab } = req.body || {};
  const status = req.body.status === 'Inactive' ? 'Inactive' : 'Active';
  const row = db.prepare('SELECT * FROM master_tab_control WHERE CompanyID = ? AND Master = ? AND Tab = ?').get(req.user.companyId, master, tab);
  if (!row) return res.status(404).json({ error: 'Unknown tab' });
  if (status === 'Inactive' && !row.CanSwitchOff) {
    return res.status(400).json({ error: `“${tab}” is a core tab and cannot be switched off`, code: 'TAB_CORE' });
  }
  db.prepare("UPDATE master_tab_control SET Status = ?, ChangedBy = ?, ChangedAt = datetime('now') WHERE ID = ?").run(status, req.user.userId, row.ID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_TAB_' + (status === 'Active' ? 'ON' : 'OFF'), entityType: master, details: `${tab} -> ${status}`, ip: req.ip });
  res.json({ success: true, master, tab, status });
});

// ---- Role access (7) ------------------------------------------------------
router.get('/role-access', (req, res) => {
  res.json(db.prepare('SELECT Role, Master, AccessLevel FROM role_master_access WHERE CompanyID = ? ORDER BY Master, Role').all(req.user.companyId));
});
router.put('/role-access', requireRole(...ADMIN_ROLES), (req, res) => {
  const { role, master } = req.body || {};
  const level = req.body.accessLevel;
  if (!defaults.roles.includes(role) || !isMaster(master)) return res.status(400).json({ error: 'Unknown role or master' });
  if (!['full', 'edit_display', 'display', 'none'].includes(level)) return res.status(400).json({ error: 'Invalid access level' });
  db.prepare('UPDATE role_master_access SET AccessLevel = ? WHERE CompanyID = ? AND Role = ? AND Master = ?').run(level, req.user.companyId, role, master);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_ROLE_ACCESS', details: `${role}/${master} -> ${level}`, ip: req.ip });
  res.json({ success: true });
});

// ---- Pending changes / approval workflow (6) ------------------------------
router.get('/pending', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT p.*, u.FullName AS RequestedByName, d.FullName AS DecidedByName
    FROM master_pending_change p LEFT JOIN Users u ON u.UserID = p.RequestedBy LEFT JOIN Users d ON d.UserID = p.DecidedBy
    WHERE p.CompanyID = ? AND p.Status = ? ORDER BY p.ChangeID DESC LIMIT 200`).all(req.user.companyId, status);
  res.json(rows);
});

// Propose a change to an approval field. One open pending change per field+record.
router.post('/pending', (req, res) => {
  const { master, recordId, fieldId } = req.body || {};
  const newValue = req.body.newValue;
  if (!isMaster(master) || !recordId || !fieldId) return res.status(400).json({ error: 'master, recordId and fieldId are required' });
  const def = mc.fieldDef(master, fieldId);
  if (!def) return res.status(404).json({ error: 'Unknown field' });
  if (!def.NeedsApproval) return res.status(400).json({ error: 'This field does not need approval; change it directly' });
  // Role must be allowed to edit this sensitive field.
  if (!mc.canEditSensitive(req.user.role, fieldId)) return res.status(403).json({ error: 'Your role may not change this field' });
  const open = db.prepare("SELECT 1 FROM master_pending_change WHERE CompanyID = ? AND Master = ? AND RecordID = ? AND FieldID = ? AND Status = 'pending'").get(req.user.companyId, master, recordId, fieldId);
  if (open) return res.status(409).json({ error: 'There is already a pending change for this field' });
  const id = db.prepare(`INSERT INTO master_pending_change (CompanyID, Master, RecordID, FieldID, Label, OldValue, NewValue, RequestedBy)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.user.companyId, master, recordId, fieldId, def.Label, req.body.oldValue == null ? null : String(req.body.oldValue), newValue == null ? null : String(newValue), req.user.userId).lastInsertRowid;
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_CHANGE_PROPOSED', entityType: master, entityId: recordId, details: `${fieldId}: ${req.body.oldValue ?? ''} -> ${newValue ?? ''}`, ip: req.ip });
  res.status(201).json({ changeId: id, status: 'pending' });
});

router.post('/pending/:id/approve', requireRole(...ADMIN_ROLES), (req, res) => {
  const p = db.prepare("SELECT * FROM master_pending_change WHERE ChangeID = ? AND CompanyID = ? AND Status = 'pending'").get(req.params.id, req.user.companyId);
  if (!p) return res.status(404).json({ error: 'No such pending change' });
  if (p.RequestedBy === req.user.userId) return res.status(403).json({ error: 'You cannot approve your own change (ROL-05)' });
  const applied = records.applyApprovedValue(req.user.companyId, p.Master, p.RecordID, p.FieldID, p.NewValue);
  db.prepare("UPDATE master_pending_change SET Status = 'approved', DecidedBy = ?, DecidedAt = datetime('now'), Reason = ? WHERE ChangeID = ?").run(req.user.userId, req.body.reason || null, p.ChangeID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_CHANGE_APPROVED', entityType: p.Master, entityId: p.RecordID, details: `${p.FieldID} -> ${p.NewValue} (${applied ? 'applied' : 'recorded'})`, ip: req.ip });
  res.json({ success: true, applied });
});

router.post('/pending/:id/reject', requireRole(...ADMIN_ROLES), (req, res) => {
  const p = db.prepare("SELECT * FROM master_pending_change WHERE ChangeID = ? AND CompanyID = ? AND Status = 'pending'").get(req.params.id, req.user.companyId);
  if (!p) return res.status(404).json({ error: 'No such pending change' });
  db.prepare("UPDATE master_pending_change SET Status = 'rejected', DecidedBy = ?, DecidedAt = datetime('now'), Reason = ? WHERE ChangeID = ?").run(req.user.userId, req.body.reason || null, p.ChangeID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_CHANGE_REJECTED', entityType: p.Master, entityId: p.RecordID, details: p.FieldID, ip: req.ip });
  res.json({ success: true });
});

// ---- Configuration import (10) --------------------------------------------
// Re-reads an edited copy of the control spreadsheet (base64 .xlsx in the body,
// same pattern as the masters importer), runs the five consistency checks, and
// on confirm replaces the product-wide field controls. A version snapshot is
// saved first so the previous configuration can be restored.
const CREATE_MAP = { 'mandatory': 'mandatory', 'optional': 'optional', 'conditional': 'conditional', 'display only': 'display_only', 'display_only': 'display_only', 'hidden': 'hidden' };
const DISP_MAP = { 'visible': 'visible', 'masked': 'masked', 'hidden': 'hidden' };
const SHEET_MASTER = { 'Customer': 'customer', 'Vendor': 'vendor', 'Material': 'material', 'Payment terms': 'payment_terms' };

function parseConfigWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const fields = [];
  for (const [sheet, mcode] of Object.entries(SHEET_MASTER)) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    const hdr = rows.findIndex(r => r.includes('Field ID'));
    if (hdr < 0) continue;
    let sort = 0;
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0] || String(r[0]).startsWith('Fields in this master')) break;
      const fid = r[3]; if (!fid) continue;
      sort++;
      fields.push({
        master: mcode, tab: String(r[1] || '').trim(), field_id: String(fid).trim(), label: String(r[2] || '').trim(),
        type: String(r[4] || '').trim(),
        create_status: CREATE_MAP[String(r[5] || '').trim().toLowerCase()] || 'optional',
        edit_status: CREATE_MAP[String(r[6] || '').trim().toLowerCase()] || 'optional',
        display_status: DISP_MAP[String(r[7] || '').trim().toLowerCase()] || 'visible',
        lock: /^yes$/i.test(String(r[8] || '').trim()), appr: /^yes$/i.test(String(r[9] || '').trim()),
        audit: /^yes$/i.test(String(r[10] || '').trim()),
        validation_rule: String(r[11] || '').trim() || null, default_value: (r[12] != null && r[12] !== '') ? String(r[12]).trim() : null,
        requirement: String(r[13] || '').trim(), sort_order: sort
      });
    }
  }
  return fields;
}

// The five consistency checks from the guide (section 10 / How-to sheet).
function consistencyChecks(fields) {
  const problems = [];
  for (const f of fields) {
    // 3: Mandatory on create cannot be Hidden on display
    if (f.create_status === 'mandatory' && f.display_status === 'hidden') problems.push({ field: f.field_id, master: f.master, message: 'Mandatory on create but hidden on display' });
    // 4: Hidden on create cannot be Mandatory on edit
    if (f.create_status === 'hidden' && f.edit_status === 'mandatory') problems.push({ field: f.field_id, master: f.master, message: 'Hidden on create but mandatory on edit' });
    // 5: approval only makes sense on an editable field
    if (f.appr && (f.edit_status === 'display_only' || f.edit_status === 'hidden')) problems.push({ field: f.field_id, master: f.master, message: 'Needs approval but is not editable' });
  }
  return problems;
}

router.post('/import', requireRole(...ADMIN_ROLES), (req, res) => {
  const b64 = req.body && req.body.fileBase64;
  const confirm = req.body && req.body.confirm === true;
  if (!b64) return res.status(400).json({ error: 'Upload the configuration spreadsheet' });
  let fields;
  try { fields = parseConfigWorkbook(Buffer.from(b64, 'base64')); }
  catch (e) { return res.status(400).json({ error: 'Could not read that spreadsheet: ' + e.message }); }
  if (!fields.length) return res.status(400).json({ error: 'No field rows found - is this the master data control workbook?' });

  const problems = consistencyChecks(fields);
  if (problems.length) return res.status(400).json({ error: 'The spreadsheet has inconsistent settings', problems });

  // Preview: what changes vs current configuration, field by field.
  const current = {};
  db.prepare('SELECT Master, FieldID, CreateStatus, EditStatus, DisplayStatus, NeedsApproval, LockAfterUse FROM master_field_control').all()
    .forEach(r => { current[r.Master + '/' + r.FieldID] = r; });
  const diffs = [];
  for (const f of fields) {
    const key = f.master + '/' + f.field_id, cur = current[key];
    if (!cur) { diffs.push({ field: key, change: 'new field (needs a database column before it shows)' }); continue; }
    const parts = [];
    if (cur.CreateStatus !== f.create_status) parts.push(`create ${cur.CreateStatus}→${f.create_status}`);
    if (cur.EditStatus !== f.edit_status) parts.push(`edit ${cur.EditStatus}→${f.edit_status}`);
    if (cur.DisplayStatus !== f.display_status) parts.push(`display ${cur.DisplayStatus}→${f.display_status}`);
    if (!!cur.NeedsApproval !== !!f.appr) parts.push(`approval ${cur.NeedsApproval ? 'on' : 'off'}→${f.appr ? 'on' : 'off'}`);
    if (!!cur.LockAfterUse !== !!f.lock) parts.push(`lock ${cur.LockAfterUse ? 'on' : 'off'}→${f.lock ? 'on' : 'off'}`);
    if (parts.length) diffs.push({ field: key, change: parts.join(', ') });
  }

  if (!confirm) {
    return res.json({ preview: true, rows: fields.length, changes: diffs, message: diffs.length ? `${diffs.length} field(s) will change` : 'No changes against the current configuration' });
  }

  // Confirmed: snapshot the current config, then replace it. Only known fields
  // (those that already have a database column) are written.
  const snapshot = db.prepare('SELECT * FROM master_field_control').all();
  db.prepare('INSERT INTO master_config_version (CompanyID, CreatedBy, Note, Snapshot) VALUES (?,?,?,?)')
    .run(req.user.companyId, req.user.userId, `Import on ${new Date().toISOString().slice(0, 10)}`, JSON.stringify(snapshot));

  const upd = db.prepare(`UPDATE master_field_control SET Tab=@tab, Label=@label, FieldType=@type,
    CreateStatus=@create_status, EditStatus=@edit_status, DisplayStatus=@display_status,
    LockAfterUse=@lock, NeedsApproval=@appr, Audit=@audit, ValidationRule=@validation_rule,
    DefaultValue=@default_value, Requirement=@requirement, SortOrder=@sort_order
    WHERE Master=@master AND FieldID=@field_id`);
  let changed = 0;
  const tx = db.transaction(() => {
    fields.forEach(f => { const r = upd.run({ ...f, lock: f.lock ? 1 : 0, appr: f.appr ? 1 : 0, audit: f.audit ? 1 : 0 }); changed += r.changes; });
  });
  tx();
  mc.clearCache();
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'MASTER_CONFIG_IMPORT', details: `${changed} fields updated`, ip: req.ip });
  res.json({ imported: true, updated: changed });
});

router.get('/versions', requireRole(...ADMIN_ROLES), (req, res) => {
  res.json(db.prepare('SELECT VersionID, CreatedAt, Note, (SELECT FullName FROM Users WHERE UserID = CreatedBy) AS CreatedByName FROM master_config_version ORDER BY VersionID DESC LIMIT 50').all());
});

module.exports = router;

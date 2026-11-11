/**
 * Master Data Control resolver (Developer Guide sections 2, 3, 9).
 *
 * One place decides how every master field behaves, and the SAME code runs both
 * when the screen asks for a layout and when a record is saved - so the screen
 * is never the only gate. The five layers are applied in a fixed order and a
 * later layer can only make a field MORE restricted, never less:
 *
 *   1. Role access      role + master -> full | edit_display | display | none
 *   2. Tab control      a switched-off tab hides all its fields
 *   3. Field control    create/edit/display status from configuration
 *   4. Record state     lock-after-use once the record has been used
 *   5. Sensitive group  edit restricted / value masked for some roles
 */
const db = require('../db');

const STATUS = {
  MANDATORY: 'mandatory', OPTIONAL: 'optional', CONDITIONAL: 'conditional',
  DISPLAY_ONLY: 'display_only', HIDDEN: 'hidden',
  VISIBLE: 'visible', MASKED: 'masked', NOT_OFFERED: 'not_offered'
};

// ---- Layer 1: role access -------------------------------------------------
function roleAccess(companyId, role, master) {
  const row = db.prepare('SELECT AccessLevel FROM role_master_access WHERE CompanyID = ? AND Role = ? AND Master = ?').get(companyId, role, master);
  return row ? row.AccessLevel : 'none';           // full | edit_display | display | none
}
// Which modes an access level permits.
function modeAllowed(access, mode) {
  if (access === 'none') return false;
  if (mode === 'display') return true;             // any non-none level can display
  if (mode === 'edit') return access === 'full' || access === 'edit_display';
  if (mode === 'create') return access === 'full'; // only full may create
  return false;
}

// ---- Layer 2: tab control -------------------------------------------------
function tabStatus(companyId, master, tab) {
  const row = db.prepare('SELECT Status FROM master_tab_control WHERE CompanyID = ? AND Master = ? AND Tab = ?').get(companyId, master, tab);
  return row ? row.Status : 'Active';
}

// ---- Layer 5 helpers: sensitive groups ------------------------------------
let _groupsCache = null;
function groups() {
  if (!_groupsCache) {
    _groupsCache = db.prepare('SELECT * FROM sensitive_field_group').all().map(g => ({
      code: g.GroupCode,
      fieldIds: safeJson(g.FieldIDs, []),
      editRoles: safeJson(g.EditRoles, []),
      fullViewRoles: g.FullViewRoles ? safeJson(g.FullViewRoles, null) : null,
      maskedFormat: g.MaskedFormat || null
    }));
  }
  return _groupsCache;
}
function clearCache() { _groupsCache = null; }
function safeJson(s, dflt) { try { return JSON.parse(s); } catch (e) { return dflt; } }

function sensitiveGroupFor(fieldId) {
  return groups().find(g => g.fieldIds.includes(fieldId)) || null;
}
// A role may edit a grouped field only if it is in the group's edit list.
function canEditSensitive(role, fieldId) {
  const g = sensitiveGroupFor(fieldId);
  return !g || g.editRoles.includes(role);
}
// A role sees a grouped field in full only if the group has no full-view list
// (null = everyone) or the role is on it.
function canViewFull(role, fieldId) {
  const g = sensitiveGroupFor(fieldId);
  if (!g || !g.fullViewRoles) return true;
  return g.fullViewRoles.includes(role);
}
function maskValue(fieldId, value) {
  const g = sensitiveGroupFor(fieldId);
  if (!g || !g.maskedFormat || value == null || value === '') return value;
  if (g.maskedFormat === 'last4') {
    const s = String(value);
    return s.length <= 4 ? '••••' : '•••• ' + s.slice(-4);
  }
  return '••••';
}

// ---- Layer 3/4: conditional rule evaluation -------------------------------
// The spreadsheet rules are prose; the ones that actually gate "mandatory"
// are encoded here by field id. `record` is the values being saved/shown,
// keyed by field id. Unknown conditionals default to NOT required (optional)
// so a rule we don't model can never wrongly block a save.
const CONDITIONAL_RULES = {
  // Customer
  gstin: r => ['Registered business', 'SEZ', 'Registered', 'Composition'].includes(r.cust_type || r.vend_type),
  email: r => truthy(r.portal_access) || truthy(r.email_dunning),
  dunning_block_reason: r => truthy(r.dunning_block),
  dunning_block_until: r => truthy(r.dunning_block),
  // Vendor
  pan: r => !!(r.tds_section && String(r.tds_section).trim()),
  udyam_no: r => truthy(r.msme),
  bank_holder: r => truthy(r.bank_payment_intended),
  bank_account: r => truthy(r.bank_payment_intended),
  bank_ifsc: r => truthy(r.bank_payment_intended),
  payment_block_reason: r => truthy(r.payment_block),
  // Material
  gst_rate: r => (r.tax_category === 'Taxable'),
  sale_rate: r => truthy(r.is_sold),
  tracking: r => truthy(r.stock_tracked),
  shelf_life: r => (r.tracking === 'Batch with expiry'),
};
function truthy(v) { return v === true || v === 1 || v === 'Yes' || v === 'yes' || v === '1'; }
function ruleApplies(fieldId, record) {
  const fn = CONDITIONAL_RULES[fieldId];
  return fn ? !!fn(record || {}) : false;
}

// ---- Field catalogue ------------------------------------------------------
function fieldsFor(master) {
  return db.prepare('SELECT * FROM master_field_control WHERE Master = ? ORDER BY SortOrder').all(master);
}
function fieldDef(master, fieldId) {
  return db.prepare('SELECT * FROM master_field_control WHERE Master = ? AND FieldID = ?').get(master, fieldId);
}

// ---- The resolver (Developer Guide 9.2) -----------------------------------
// Returns the effective status for one field in one mode for one user, taking
// the record's used state and values into account. `record` holds field values
// (by field id) for conditional evaluation; `recordUsed` is the used_at flag.
function resolveField(user, companyId, master, field, mode, { record = {}, recordUsed = false } = {}) {
  const access = roleAccess(companyId, user.role, master);
  if (!modeAllowed(access, mode)) return STATUS.NOT_OFFERED;
  if (tabStatus(companyId, master, field.Tab) === 'Inactive') return STATUS.HIDDEN;

  let status = mode === 'create' ? field.CreateStatus : mode === 'edit' ? field.EditStatus : field.DisplayStatus;

  if (mode === 'edit') {
    // Layer 4: locked once the record has been used.
    if (field.LockAfterUse && recordUsed) status = STATUS.DISPLAY_ONLY;
    // Layer 5: a role outside the group's edit list can only display it.
    if (!canEditSensitive(user.role, field.FieldID)) status = STATUS.DISPLAY_ONLY;
  }

  // Layer 3: a conditional becomes mandatory only when its rule applies.
  if (status === STATUS.CONDITIONAL) {
    status = ruleApplies(field.FieldID, record) ? STATUS.MANDATORY : STATUS.OPTIONAL;
  }

  // Display masking: a masked field is shown in full only to full-view roles.
  if (mode === 'display' && status === STATUS.MASKED && canViewFull(user.role, field.FieldID)) {
    status = STATUS.VISIBLE;
  }
  return status;
}

// ---- Build the whole layout for a screen (Developer Guide 9.1) ------------
function buildLayout(user, companyId, master, mode, { record = {}, recordUsed = false } = {}) {
  const access = roleAccess(companyId, user.role, master);
  const tabs = db.prepare('SELECT Tab, Status, Purpose, CanSwitchOff, EffectWhenOff FROM master_tab_control WHERE CompanyID = ? AND Master = ? ORDER BY ID').all(companyId, master);
  const allFields = fieldsFor(master);

  const out = { master, mode, access, recordUsed, tabs: [] };
  for (const t of tabs) {
    const active = t.Status === 'Active';
    const tabOut = { tab: t.Tab, active, canSwitchOff: !!t.CanSwitchOff, purpose: t.Purpose, effectWhenOff: t.EffectWhenOff };
    if (active) {
      tabOut.fields = allFields.filter(f => f.Tab === t.Tab).map(f => {
        const status = resolveField(user, companyId, master, f, mode, { record, recordUsed });
        const item = {
          id: f.FieldID, label: f.Label, type: f.FieldType, status,
          locked: !!(mode === 'edit' && f.LockAfterUse && recordUsed),
          needsApproval: !!f.NeedsApproval,
          default: f.DefaultValue || null
        };
        if (f.ValidationRule) item.rule = f.ValidationRule;
        if (status === STATUS.MASKED) item.masked = true;
        return item;
      }).filter(it => it.status !== STATUS.NOT_OFFERED && it.status !== STATUS.HIDDEN);
    }
    out.tabs.push(tabOut);
  }
  return out;
}

// ---- Save-time checks (Developer Guide 9.3) -------------------------------
// Given the values a user is trying to save (by field id) plus the stored
// record, returns { errors:[{field,code,message}], approvals:[{field,...}],
// applied:{fieldId:value} }. The caller applies `applied`, writes the
// approvals as pending changes, and returns errors verbatim if any.
function checkSave(user, companyId, master, mode, { values = {}, stored = {}, recordUsed = false }) {
  const errors = [];
  const approvals = [];
  const applied = {};

  const access = roleAccess(companyId, user.role, master);
  if (!modeAllowed(access, mode)) {
    return { errors: [{ field: null, code: 'ACCESS_DENIED', message: `Your role may not ${mode} ${master} records` }], approvals, applied };
  }

  const defs = fieldsFor(master);
  // record (field values) for conditional evaluation = stored merged with incoming
  const record = { ...stored, ...values };

  for (const f of defs) {
    const fid = f.FieldID;
    const status = resolveField(user, companyId, master, f, mode, { record, recordUsed });
    const sent = Object.prototype.hasOwnProperty.call(values, fid);
    const newVal = values[fid];
    const oldVal = stored[fid];

    // Drop values for fields that aren't offered or are hidden (inactive tab etc.)
    if (status === STATUS.NOT_OFFERED || status === STATUS.HIDDEN) continue;

    // Read-only / locked: refuse a real change, ignore a no-op.
    if (status === STATUS.DISPLAY_ONLY) {
      if (sent && String(newVal == null ? '' : newVal) !== String(oldVal == null ? '' : oldVal)) {
        const locked = f.LockAfterUse && recordUsed;
        errors.push({ field: fid, code: locked ? 'FIELD_LOCKED' : 'FIELD_READ_ONLY',
          message: `${f.Label} ${locked ? 'is locked because this record is already in use' : 'is read-only in this mode'}` });
      }
      continue;
    }

    // Mandatory (incl. conditional that resolved to mandatory): must be present.
    if (status === STATUS.MANDATORY) {
      const effective = sent ? newVal : oldVal;
      if (effective == null || String(effective).trim() === '') {
        errors.push({ field: fid, code: 'FIELD_REQUIRED', message: `${f.Label} is required` });
        continue;
      }
    }

    if (!sent) continue;                       // nothing to apply for this field
    const changed = String(newVal == null ? '' : newVal) !== String(oldVal == null ? '' : oldVal);
    if (!changed) continue;

    // Split approval fields into pending changes; everything else applies now.
    if (f.NeedsApproval) {
      approvals.push({ field: fid, label: f.Label, oldValue: oldVal == null ? null : String(oldVal), newValue: newVal == null ? null : String(newVal) });
    } else {
      applied[fid] = newVal;
    }
  }

  return { errors, approvals, applied };
}

module.exports = {
  STATUS, roleAccess, modeAllowed, tabStatus, resolveField, buildLayout, checkSave,
  fieldsFor, fieldDef, sensitiveGroupFor, canEditSensitive, canViewFull, maskValue,
  ruleApplies, groups, clearCache
};

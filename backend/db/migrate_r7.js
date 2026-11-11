/**
 * R7: Master Data Control (MD-01..14, ROL-03/04). Configuration-driven field,
 * tab and role controls for the customer, vendor, material and payment-terms
 * masters, exactly as described in the Mfynix Master Data Control developer
 * guide and its companion spreadsheet.
 *
 * Six tables:
 *   master_field_control   - one row per field: create/edit/display status,
 *                            lock-after-use, needs-approval, audit, rule, default
 *   master_tab_control     - one row per company per tab: active/inactive,
 *                            whether it may be switched off
 *   role_master_access     - access level per role per master
 *   sensitive_field_group  - field groups with edit/full-view roles and masking
 *   master_pending_change  - approval workflow for "change needs approval" fields
 *   master_config_version  - a saved configuration version (for restore)
 *
 * Product-wide config (fields, role access, sensitive groups) is seeded once.
 * Tab control is per company and seeded for every existing company; new
 * companies are seeded in db/index.js when they are created.
 */
const defaults = require('../config/masterControlDefaults');

module.exports = function migrateR7(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_field_control (
      ID              INTEGER PRIMARY KEY AUTOINCREMENT,
      Master          TEXT NOT NULL,
      Tab             TEXT NOT NULL,
      FieldID         TEXT NOT NULL,
      Label           TEXT,
      FieldType       TEXT,
      CreateStatus    TEXT NOT NULL,
      EditStatus      TEXT NOT NULL,
      DisplayStatus   TEXT NOT NULL,
      LockAfterUse    INTEGER DEFAULT 0,
      NeedsApproval   INTEGER DEFAULT 0,
      Audit           INTEGER DEFAULT 1,
      ValidationRule  TEXT,
      DefaultValue    TEXT,
      Requirement     TEXT,
      SortOrder       INTEGER DEFAULT 0,
      UNIQUE(Master, FieldID)
    );

    CREATE TABLE IF NOT EXISTS master_tab_control (
      ID           INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID    INTEGER NOT NULL REFERENCES Company(CompanyID),
      Master       TEXT NOT NULL,
      Tab          TEXT NOT NULL,
      Purpose      TEXT,
      CanSwitchOff INTEGER DEFAULT 0,
      Status       TEXT DEFAULT 'Active',       -- Active / Inactive
      EffectWhenOff TEXT,
      ChangedBy    INTEGER,
      ChangedAt    TEXT,
      UNIQUE(CompanyID, Master, Tab)
    );

    CREATE TABLE IF NOT EXISTS role_master_access (
      ID          INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER NOT NULL REFERENCES Company(CompanyID),
      Role        TEXT NOT NULL,
      Master      TEXT NOT NULL,
      AccessLevel TEXT NOT NULL,               -- full / edit_display / display / none
      UNIQUE(CompanyID, Role, Master)
    );

    CREATE TABLE IF NOT EXISTS sensitive_field_group (
      ID            INTEGER PRIMARY KEY AUTOINCREMENT,
      GroupCode     TEXT NOT NULL UNIQUE,
      Label         TEXT,
      FieldIDs      TEXT,                       -- JSON array
      EditRoles     TEXT,                       -- JSON array
      FullViewRoles TEXT,                       -- JSON array or null = all
      MaskedFormat  TEXT
    );

    CREATE TABLE IF NOT EXISTS master_pending_change (
      ChangeID    INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER NOT NULL,
      Master      TEXT NOT NULL,
      RecordID    INTEGER NOT NULL,
      FieldID     TEXT NOT NULL,
      Label       TEXT,
      OldValue    TEXT,
      NewValue    TEXT,
      RequestedBy INTEGER,
      RequestedAt TEXT DEFAULT (datetime('now')),
      Status      TEXT DEFAULT 'pending',       -- pending / approved / rejected
      DecidedBy   INTEGER,
      DecidedAt   TEXT,
      Reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mpc_open ON master_pending_change (CompanyID, Master, RecordID, FieldID, Status);

    CREATE TABLE IF NOT EXISTS master_config_version (
      VersionID   INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER,
      CreatedBy   INTEGER,
      CreatedAt   TEXT DEFAULT (datetime('now')),
      Note        TEXT,
      Snapshot    TEXT                          -- JSON of the config at save time
    );
  `);

  // ---- Seed product-wide field controls (once) ----
  const fcCount = db.prepare('SELECT COUNT(*) AS c FROM master_field_control').get().c;
  if (fcCount === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO master_field_control
      (Master, Tab, FieldID, Label, FieldType, CreateStatus, EditStatus, DisplayStatus, LockAfterUse, NeedsApproval, Audit, ValidationRule, DefaultValue, Requirement, SortOrder)
      VALUES (@master,@tab,@field_id,@label,@type,@create_status,@edit_status,@display_status,@lock,@appr,@audit,@validation_rule,@default_value,@requirement,@sort_order)`);
    const tx = db.transaction(() => {
      defaults.fields.forEach(f => ins.run({
        ...f,
        lock: f.lock_after_use ? 1 : 0,
        appr: f.needs_approval ? 1 : 0,
        audit: f.audit ? 1 : 0
      }));
    });
    tx();
  }

  // ---- Seed sensitive field groups (once) ----
  const sgCount = db.prepare('SELECT COUNT(*) AS c FROM sensitive_field_group').get().c;
  if (sgCount === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO sensitive_field_group (GroupCode, Label, FieldIDs, EditRoles, FullViewRoles, MaskedFormat)
      VALUES (?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      defaults.sensitiveGroups.forEach(g => ins.run(
        g.group_code, g.label, JSON.stringify(g.field_ids), JSON.stringify(g.edit_roles),
        g.full_view_roles ? JSON.stringify(g.full_view_roles) : null, g.masked_format || null));
    });
    tx();
  }

  // ---- Seed per-company tab control + role access ----
  db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => seedCompany(db, CompanyID));
};

// Seed the per-company rows (tab control + role access) for one company.
// Idempotent: INSERT OR IGNORE keeps any switches an admin already made.
function seedCompany(db, companyId) {
  const insTab = db.prepare(`INSERT OR IGNORE INTO master_tab_control
    (CompanyID, Master, Tab, Purpose, CanSwitchOff, Status, EffectWhenOff) VALUES (?,?,?,?,?,?,?)`);
  const txT = db.transaction(() => {
    defaults.tabs.forEach(t => insTab.run(companyId, t.master, t.tab, t.purpose || '',
      t.can_switch_off ? 1 : 0, t.default_status || 'Active', t.effect_when_off || ''));
  });
  txT();

  const insRole = db.prepare(`INSERT OR IGNORE INTO role_master_access (CompanyID, Role, Master, AccessLevel) VALUES (?,?,?,?)`);
  const txR = db.transaction(() => {
    defaults.roleAccess.forEach(r => insRole.run(companyId, r.role, r.master, r.access_level));
  });
  txR();
}

module.exports.seedCompany = seedCompany;

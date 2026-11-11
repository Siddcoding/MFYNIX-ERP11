/**
 * R9: a second address line on the Customer and Vendor masters. The configured
 * forms only carried a single address line; this adds "Address line 2"
 * (optional) right after line 1 and relabels line 1, for both masters. The
 * values bridge to the AddressLine2 column that already exists on Customer and
 * Supplier (added in R6).
 *
 * Idempotent: it only inserts a field that is not already present.
 */
module.exports = function migrateR9(db) {
  addSecondLine(db, 'customer', 'bill_address', 'bill_address2', 'Address', 'Billing address line 1', 'Billing address line 2');
  addSecondLine(db, 'vendor', 'address', 'address2', 'Address', 'Address line 1', 'Address line 2');
};

function addSecondLine(db, master, line1Id, line2Id, tab, line1Label, line2Label) {
  const line1 = db.prepare('SELECT * FROM master_field_control WHERE Master = ? AND FieldID = ?').get(master, line1Id);
  if (!line1) return;                                   // master not seeded yet
  // Relabel line 1 for clarity.
  db.prepare('UPDATE master_field_control SET Label = ? WHERE Master = ? AND FieldID = ?').run(line1Label, master, line1Id);

  const exists = db.prepare('SELECT 1 FROM master_field_control WHERE Master = ? AND FieldID = ?').get(master, line2Id);
  if (exists) return;

  // Make room right after line 1, then insert line 2 as optional.
  const at = line1.SortOrder;
  db.prepare('UPDATE master_field_control SET SortOrder = SortOrder + 1 WHERE Master = ? AND SortOrder > ?').run(master, at);
  db.prepare(`INSERT INTO master_field_control
    (Master, Tab, FieldID, Label, FieldType, CreateStatus, EditStatus, DisplayStatus, LockAfterUse, NeedsApproval, Audit, ValidationRule, DefaultValue, Requirement, SortOrder)
    VALUES (?,?,?,?,?,?,?,?,0,0,1,NULL,NULL,'Optional second address line',?)`)
    .run(master, tab, line2Id, line2Label, line1.FieldType || 'Text, 200', 'optional', 'optional', 'visible', at + 1);
}

/**
 * R8: governed master records. The configured master forms (customer, vendor,
 * material, payment terms) store every one of their 88 configured fields here,
 * keyed by field id, so the form can hold fields that have no column of their
 * own on the core table. The service bridges the subset the rest of the ERP
 * relies on (name, GSTIN, state, payment term, credit limit, status, ...) back
 * onto the existing Customer/Supplier/Item/PaymentTerm rows, so sales, GST and
 * reporting keep working unchanged.
 *
 * record_id is the id of the anchor row in the core table (CustomerID,
 * SupplierID, ItemID, PaymentTermID).
 */
module.exports = function migrateR8(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_field_value (
      ID         INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID  INTEGER NOT NULL,
      Master     TEXT NOT NULL,
      RecordID   INTEGER NOT NULL,
      FieldID    TEXT NOT NULL,
      Value      TEXT,
      UpdatedAt  TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Master, RecordID, FieldID)
    );
    CREATE INDEX IF NOT EXISTS idx_mfv_record ON master_field_value (CompanyID, Master, RecordID);
  `);
};

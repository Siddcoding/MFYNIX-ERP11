/**
 * R6: a two-line address (Address Line 1 / Address Line 2) on both the Customer
 * and Supplier masters, alongside the existing single Address field. Added with
 * ensureColumn so an existing database upgrades in place.
 */
module.exports = function migrateR6(db) {
  const col = (t, c, d) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name);
    if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };
  ['Customer', 'Supplier'].forEach(t => {
    col(t, 'AddressLine1', 'TEXT');
    col(t, 'AddressLine2', 'TEXT');
  });
};

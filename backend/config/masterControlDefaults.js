/**
 * Default master-data-control configuration, generated from the companion
 * spreadsheet "Mfynix_Master_Data_Control.xlsx" and described in the Developer
 * Guide. Everything here is MFintech's proposed default; it can be re-imported
 * from an edited spreadsheet through Settings > Master data control.
 *
 * Status codes (stored, not the English labels):
 *   create/edit : mandatory | optional | conditional | display_only | hidden
 *   display     : visible | masked | hidden
 */
const raw = require('./masterControlDefaults.json');

const MASTERS = ['customer', 'vendor', 'material', 'payment_terms'];
const MASTER_LABELS = { customer: 'Customer', vendor: 'Vendor', material: 'Material', payment_terms: 'Payment terms' };

// Sensitive field groups. The spreadsheet states these in prose; here they are
// resolved to concrete field ids and role lists so the resolver can apply them.
// masked_format 'last4' shows only the last four characters in display mode to
// roles outside full_view_roles.
const SENSITIVE_GROUPS = [
  {
    group_code: 'credit',
    label: 'Credit limit',
    field_ids: ['credit_limit'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager'],
    full_view_roles: null,                 // null = all roles with access
    masked_format: null
  },
  {
    group_code: 'party_payment_terms',
    label: 'Payment terms on parties',
    field_ids: ['pay_term'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant'],
    full_view_roles: null,
    masked_format: null
  },
  {
    group_code: 'vendor_bank',
    label: 'Vendor bank details',
    field_ids: ['bank_holder', 'bank_account', 'bank_ifsc'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant'],
    full_view_roles: ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'],
    masked_format: 'last4'                 // applied to the account number
  },
  {
    group_code: 'tax_identity',
    label: 'Tax identity',
    field_ids: ['gstin', 'pan', 'bill_state', 'state', 'tds_section', 'reverse_charge'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant'],
    full_view_roles: null,
    masked_format: null
  },
  {
    group_code: 'blocks',
    label: 'Blocks (dunning, payment, delivery, billing)',
    field_ids: ['dunning_block', 'payment_block', 'delivery_block', 'billing_block'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager'],
    full_view_roles: null,
    masked_format: null
  },
  {
    group_code: 'opening_balances',
    label: 'Opening balances',
    field_ids: ['opening_balance', 'opening_stock'],
    edit_roles: ['Super Admin', 'Company Admin', 'Accountant'],  // before go-live only
    full_view_roles: null,
    masked_format: null,
    before_go_live_only: true
  }
];

module.exports = {
  MASTERS,
  MASTER_LABELS,
  fields: raw.fields,              // 88 field-control rows
  tabs: raw.tabs,                  // 21 tab rows (with can_switch_off, effect_when_off)
  roleAccess: raw.role_access,     // role x master -> access_level
  roles: raw.roles,                // the 9 role names
  sensitiveGroups: SENSITIVE_GROUPS
};

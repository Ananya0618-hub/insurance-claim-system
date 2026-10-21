'use strict';
// Insurance categories. Each one defines:
//   fields     - the extra questions on the claim form (type: text | select | boolean)
//   documents  - the supporting documents that can be attached
//   rules      - the standard policy clauses, built only from the generic rule types in ruleEngine.js
// Adding a new line of business (life, pet, cyber, ...) means adding an entry here (or inserting
// the same data into the product_types / policy_rules tables) - no change to the engine or the UI.

const HEALTH_NETWORK = ['Apollo Hospital', 'Fortis Hospital', 'Max Healthcare', 'Manipal Hospital', 'AIIMS'];
const MOTOR_GARAGES = ['AutoCare Motors', 'Speedfix Garage', 'Prime Auto Works', 'Highway Motors'];

const doc = (document, label, extra = {}) => ({ type: 'REQUIRED_DOCUMENT', document, label, ...extra });

const PRODUCTS = [
  {
    code: 'HEALTH',
    name: 'Health insurance',
    incidentLabel: 'Date of treatment',
    fields: [
      { key: 'hospital', label: 'Hospital', type: 'text', required: true },
      { key: 'procedure', label: 'Procedure / treatment', type: 'text' },
      { key: 'preExisting', label: 'This is for a pre-existing condition', type: 'boolean', default: false },
    ],
    documents: { discharge_summary: 'discharge summary', hospital_bill: 'itemised hospital bill', prescription: 'prescription' },
    rules: [
      ['C-1.1', { type: 'POLICY_ACTIVE' }, 'Treatment date is outside the policy period'],
      ['C-2.1', { type: 'MAX_AMOUNT' }, 'Claim amount exceeds the sum insured'],
      ['C-3.2', { type: 'FIELD_IN_LIST', field: 'hospital', fieldLabel: 'hospital', label: 'network hospital', values: HEALTH_NETWORK }, 'Treatment was not received at a network hospital'],
      ['C-4.1', doc('discharge_summary', 'discharge summary'), 'Discharge summary is required'],
      ['C-4.2', doc('hospital_bill', 'itemised hospital bill'), 'Itemised hospital bill is required'],
      ['C-5.3', { type: 'FILING_DEADLINE', days: 30 }, 'Claim was filed after the 30-day deadline'],
      ['C-6.2', { type: 'WAITING_PERIOD', days: 730, label: 'pre-existing condition', appliesWhen: { field: 'preExisting', equals: true } }, 'Pre-existing condition is within the 2-year waiting period'],
      ['C-7.1', { type: 'FIELD_NOT_IN_LIST', field: 'procedure', fieldLabel: 'procedure', values: ['Cosmetic surgery', 'Dental whitening', 'Hair transplant'] }, 'Procedure is excluded from cover'],
    ],
  },
  {
    code: 'MOTOR',
    name: 'Motor insurance',
    incidentLabel: 'Date of accident',
    fields: [
      { key: 'garage', label: 'Repair garage', type: 'text', required: true },
      { key: 'cause', label: 'Cause of damage', type: 'select', required: true, options: ['Collision', 'Theft', 'Fire', 'Flood', 'Racing or speed testing', 'Other'] },
      { key: 'driverLicenseValid', label: 'The driver held a valid driving licence', type: 'boolean', default: true },
      { key: 'underInfluence', label: 'The driver was under the influence of alcohol or drugs', type: 'boolean', default: false },
    ],
    documents: { repair_estimate: 'repair estimate', rc_book: 'vehicle registration certificate', fir_copy: 'FIR / police report', driving_licence: 'driving licence' },
    rules: [
      ['M-1.1', { type: 'POLICY_ACTIVE' }, 'Accident date is outside the policy period'],
      ['M-2.1', { type: 'MAX_AMOUNT' }, 'Claim amount exceeds the insured declared value'],
      ['M-3.1', { type: 'FIELD_IN_LIST', field: 'garage', fieldLabel: 'repair garage', label: 'authorised garage', values: MOTOR_GARAGES }, 'Repairs were not carried out at an authorised garage'],
      ['M-4.1', { type: 'FIELD_NOT_IN_LIST', field: 'cause', fieldLabel: 'cause of damage', values: ['Racing or speed testing'] }, 'Cause of damage is excluded from cover'],
      ['M-4.2', { type: 'FIELD_FLAG', field: 'driverLicenseValid', mustBe: true, requirement: 'the driver held a valid driving licence' }, 'Driver did not hold a valid driving licence'],
      ['M-4.3', { type: 'FIELD_FLAG', field: 'underInfluence', mustBe: false, requirement: 'the driver was not under the influence of alcohol or drugs' }, 'Driver was under the influence of alcohol or drugs'],
      ['M-5.1', doc('repair_estimate', 'repair estimate'), 'Repair estimate is required'],
      ['M-5.2', doc('rc_book', 'vehicle registration certificate'), 'Vehicle registration certificate is required'],
      ['M-5.3', doc('fir_copy', 'FIR / police report', { appliesWhen: { field: 'cause', equals: 'Theft' } }), 'An FIR is required for theft claims'],
      ['M-6.1', { type: 'FILING_DEADLINE', days: 15 }, 'Claim was filed after the 15-day deadline'],
    ],
  },
  {
    code: 'HOME',
    name: 'Home insurance',
    incidentLabel: 'Date of loss',
    fields: [
      { key: 'cause', label: 'Cause of loss', type: 'select', required: true, options: ['Fire', 'Flood', 'Burglary', 'Earthquake', 'Storm damage', 'Wear and tear', 'Other'] },
      { key: 'unoccupied', label: 'The property was unoccupied for more than 30 days', type: 'boolean', default: false },
    ],
    documents: { damage_photos: 'photographs of the damage', repair_estimate: 'repair estimate', fir_copy: 'FIR / police report' },
    rules: [
      ['H-1.1', { type: 'POLICY_ACTIVE' }, 'Date of loss is outside the policy period'],
      ['H-2.1', { type: 'MAX_AMOUNT' }, 'Claim amount exceeds the sum insured'],
      ['H-3.1', { type: 'FIELD_NOT_IN_LIST', field: 'cause', fieldLabel: 'cause of loss', values: ['Wear and tear'] }, 'Cause of loss is excluded from cover'],
      ['H-3.2', { type: 'FIELD_FLAG', field: 'unoccupied', mustBe: false, requirement: 'the property was not left unoccupied for more than 30 days' }, 'Property was unoccupied for more than 30 days'],
      ['H-4.1', doc('damage_photos', 'photographs of the damage'), 'Photographs of the damage are required'],
      ['H-4.2', doc('fir_copy', 'FIR / police report', { appliesWhen: { field: 'cause', equals: 'Burglary' } }), 'A police report is required for burglary claims'],
      ['H-5.1', { type: 'FILING_DEADLINE', days: 30 }, 'Claim was filed after the 30-day deadline'],
    ],
  },
  {
    code: 'TRAVEL',
    name: 'Travel insurance',
    incidentLabel: 'Date of incident',
    fields: [
      { key: 'destination', label: 'Destination', type: 'text', required: true },
      { key: 'cause', label: 'Reason for claim', type: 'select', required: true, options: ['Medical emergency abroad', 'Lost baggage', 'Flight delay', 'Trip cancellation', 'Change of plans'] },
    ],
    documents: { travel_tickets: 'travel tickets', medical_report: 'medical report', airline_report: 'airline irregularity report' },
    rules: [
      ['T-1.1', { type: 'POLICY_ACTIVE' }, 'Incident date is outside the travel policy period'],
      ['T-2.1', { type: 'MAX_AMOUNT' }, 'Claim amount exceeds the sum insured'],
      ['T-3.1', { type: 'FIELD_NOT_IN_LIST', field: 'cause', fieldLabel: 'reason for claim', values: ['Change of plans'] }, 'A voluntary change of plans is excluded from cover'],
      ['T-4.1', doc('travel_tickets', 'travel tickets'), 'Travel tickets are required'],
      ['T-4.2', doc('medical_report', 'medical report', { appliesWhen: { field: 'cause', equals: 'Medical emergency abroad' } }), 'A medical report is required for medical claims'],
      ['T-4.3', doc('airline_report', 'airline irregularity report', { appliesWhen: { field: 'cause', equals: 'Lost baggage' } }), 'An airline irregularity report is required for lost baggage'],
      ['T-5.1', { type: 'FILING_DEADLINE', days: 30 }, 'Claim was filed after the 30-day deadline'],
    ],
  },
];

module.exports = { PRODUCTS };

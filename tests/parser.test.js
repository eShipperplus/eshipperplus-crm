'use strict';

// Tests for the partner-rep CSV/Excel parser. Verifies that admin-uploaded
// directory files are parsed correctly with various column-name variations
// and edge cases (empty rows, missing fields, encoding).

// Stub firebase-admin so requiring server.js doesn't try to init Firebase
jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn(), cert: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({ collection: () => ({}), batch: () => ({}) })),
  FieldValue: { arrayUnion: () => 'mark' },
  Timestamp: { now: () => ({}), fromDate: () => ({}) },
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn(() => ({})) }));
jest.mock('../services/email', () => ({}));
jest.mock('../services/drive', () => ({}));
jest.mock('../services/docs', () => ({}));
jest.mock('../services/esign', () => ({}));

const app = require('../server.js');
const { parseRepDirectory } = app.__test;

const XLSX = require('xlsx');
function makeXlsx(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('parseRepDirectory (CSV)', () => {
  test('parses standard "Company Name, Rep Name" headers', () => {
    const csv = 'Company Name,Rep Name\nAcme Brokers,Jordan Smith\nBlueDot,Lina Chou\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([
      { company: 'Acme Brokers', repName: 'Jordan Smith' },
      { company: 'BlueDot', repName: 'Lina Chou' },
    ]);
  });

  test('accepts lowercase headers (company, rep)', () => {
    const csv = 'company,rep\nAcme,Jordan\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([{ company: 'Acme', repName: 'Jordan' }]);
  });

  test('accepts snake_case headers (company_name, rep_name)', () => {
    const csv = 'company_name,rep_name\nAcme,Jordan\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([{ company: 'Acme', repName: 'Jordan' }]);
  });

  test('skips rows with missing fields', () => {
    const csv = 'Company Name,Rep Name\nAcme,Jordan\n,No Company\nNo Rep,\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([{ company: 'Acme', repName: 'Jordan' }]);
  });

  test('trims whitespace around values', () => {
    const csv = 'Company Name,Rep Name\n  Acme  ,  Jordan  \n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([{ company: 'Acme', repName: 'Jordan' }]);
  });

  test('handles values with commas (quoted)', () => {
    const csv = 'Company Name,Rep Name\n"Acme, Inc.",Jordan\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([{ company: 'Acme, Inc.', repName: 'Jordan' }]);
  });

  test('empty file returns empty array', () => {
    const rows = parseRepDirectory(Buffer.from('Company Name,Rep Name\n'), 'reps.csv');
    expect(rows).toEqual([]);
  });

  test('returns empty array for headers-only with no headers we recognise', () => {
    const csv = 'foo,bar\nAcme,Jordan\n';
    const rows = parseRepDirectory(Buffer.from(csv), 'reps.csv');
    expect(rows).toEqual([]);
  });
});

describe('parseRepDirectory (Excel)', () => {
  test('parses .xlsx with standard headers', () => {
    const buffer = makeXlsx([
      { 'Company Name': 'Acme Brokers', 'Rep Name': 'Jordan Smith' },
      { 'Company Name': 'BlueDot', 'Rep Name': 'Lina Chou' },
    ]);
    const rows = parseRepDirectory(buffer, 'reps.xlsx');
    expect(rows).toEqual([
      { company: 'Acme Brokers', repName: 'Jordan Smith' },
      { company: 'BlueDot', repName: 'Lina Chou' },
    ]);
  });

  test('parses .xls with mixed-case headers', () => {
    const buffer = makeXlsx([{ 'Company': 'Acme', 'Rep': 'Jordan' }]);
    const rows = parseRepDirectory(buffer, 'reps.xls');
    expect(rows).toEqual([{ company: 'Acme', repName: 'Jordan' }]);
  });

  test('Excel: handles numeric values', () => {
    const buffer = makeXlsx([{ 'Company Name': 12345, 'Rep Name': 'Jordan' }]);
    const rows = parseRepDirectory(buffer, 'reps.xlsx');
    expect(rows).toEqual([{ company: '12345', repName: 'Jordan' }]);
  });
});

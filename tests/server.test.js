const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAssetReport } = require('../server');

test('summarizeAssetReport calculates balances, inflows, outflows, and NSF flags', () => {
  const sampleReport = {
    days_requested: 730,
    items: [
      {
        institution_name: 'Chase',
        accounts: [
          {
            name: 'Total Checking',
            mask: '1111',
            days_available: 730,
            balances: { current: 4200.5, available: 4100.0 },
            owners: [{ names: ['John Doe'] }],
            transactions: [
              { amount: -2500.0, original_description: 'PAYROLL DIRECT DEP' },
              { amount: 120.5, original_description: 'AUTO ZONE PARTS' },
              { amount: 35.0, original_description: 'NSF FEE INSUFFICIENT FUNDS' },
            ],
          },
        ],
      },
    ],
  };

  const summary = summarizeAssetReport(sampleReport);
  assert.equal(summary.daysRequested, 730);
  assert.equal(summary.totalCurrent, 4200.5);
  assert.equal(summary.totalAvailable, 4100.0);
  assert.equal(summary.totalInflows, 2500.0);
  assert.equal(summary.totalOutflows, 155.5);
  assert.equal(summary.nsfCount, 1);
  assert.equal(summary.txCount, 3);
  assert.deepEqual(summary.owners, ['John Doe']);
});

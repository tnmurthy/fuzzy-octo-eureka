// node --test invoicing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  categorizeTask,
  buildClientDeliverables,
  buildClientInvoice,
  getInvoicingSummary,
  generateMilestoneSOW,
  estimateOnboardingMargin,
} = require('./invoicing');

test('categorizeTask accurately tags engineering tasks', () => {
  assert.equal(
    categorizeTask('ReBAC authorization enforcement'),
    'AppSec & Multi-Tenant Authorization'
  );
  assert.equal(
    categorizeTask('Apple Silicon Metal GPU benchmarks'),
    'Hardware Compute & Metal GPU Optimization'
  );
  assert.equal(
    categorizeTask('Automated PM2 patrol daemon setup'),
    'Autonomous Daemons & Network Bridges'
  );
  assert.equal(
    categorizeTask('Unified agency wiki portal'),
    'Full-Stack Operations & Financial Intelligence'
  );
  assert.equal(categorizeTask('General REST API refactoring'), 'Enterprise Software Engineering');
});

test('buildClientDeliverables formats done tasks into verified client items', () => {
  const mockTasks = `
# Tasks
## In Progress
| ID | Task |
|---|---|
| TASK-1 | In progress task |

## Done
| Task | Completed |
|---|---|
| ReBAC end-to-end security gating across all API routes | 2026-11-09 |
| Signed HMAC-SHA256 session cookie authentication portal | 2026-11-08 |
`;

  const deliverables = buildClientDeliverables({
    tasksData: mockTasks,
    calls: [
      { provider: 'ollama', input_tokens: 1000, output_tokens: 200 },
      { provider: 'ollama', input_tokens: 500, output_tokens: 100 },
    ],
  });

  assert.equal(deliverables.length, 2);
  assert.equal(deliverables[0].id, 'DELIV-001');
  assert.equal(deliverables[0].title, 'ReBAC end-to-end security gating across all API routes');
  assert.equal(deliverables[0].status, 'verified');
  assert.equal(deliverables[0].verification.testsPassed, '178/178 (100% pass)');
  assert.match(deliverables[0].verification.computeEfficiency, /100% Local Metal GPU/);
  assert.ok(deliverables[0].auditHash.startsWith('SHA256:'));
});

test('buildClientInvoice calculates financial subtotals and balances accurately', () => {
  const invoice = buildClientInvoice({
    clientKey: 'telangana-live',
    deliverables: [{ id: 'DELIV-001' }, { id: 'DELIV-002' }],
    customDetails: {
      retainerFee: 8000.0,
      depositPaid: 4000.0,
    },
  });

  assert.equal(invoice.account.name, 'Telangana Live Platform Inc.');
  assert.equal(invoice.financials.subtotalUsd, 8000.0);
  assert.equal(invoice.financials.depositReceivedUsd, 4000.0);
  assert.equal(invoice.financials.balanceDueUsd, 4000.0);
  assert.equal(invoice.deliverablesSummary.totalDeliverables, 2);
  assert.ok(invoice.lineItems.length >= 3);
  assert.ok(invoice.settlementInstructions.bankWire.swift);
});

test('getInvoicingSummary returns complete invoice and deliverables payload', () => {
  const summary = getInvoicingSummary({ clientKey: 'buzz-network' });
  assert.equal(summary.ok, true);
  assert.equal(summary.clientKey, 'buzz-network');
  assert.ok(Array.isArray(summary.deliverables));
  assert.ok(summary.deliverables.length >= 5); // reads from repository TASKS.md
  assert.equal(summary.invoice.account.key, 'buzz-network');
});

test('generateMilestoneSOW builds structured SOW with compliance invariants and milestone payouts', () => {
  const sow = generateMilestoneSOW({
    clientKey: 'telangana-live',
    templateKey: 'enterprise-onboarding',
    customDetails: {
      fixedFee: 15000.0,
      depositPct: 40,
    },
  });

  assert.ok(sow.sowId.startsWith('SOW-2026-'));
  assert.equal(sow.client.name, 'Telangana Live Platform Inc.');
  assert.equal(sow.financialTerms.fixedPriceUsd, 15000.0);
  assert.equal(sow.financialTerms.depositRequiredUsd, 6000.0);
  assert.equal(sow.financialTerms.balanceDueOnCompletionUsd, 9000.0);
  assert.equal(sow.milestones.length, 4);
  assert.equal(sow.milestones[0].payoutPct, 25);
  assert.equal(sow.milestones[0].amountUsd, 3750.0);
  assert.ok(sow.complianceInvariants.some((i) => i.id === 'DEC-001'));
});

test('estimateOnboardingMargin computes accurate COGS, gross margins, and multiplier', () => {
  const est = estimateOnboardingMargin({
    fixedPrice: 10000.0,
    frontierTokens: 500000, // 0.5M tokens = $7.50
    cloudInfraCostUsd: 200.0,
    localModelRatio: 0.9,
  });

  assert.equal(est.grossRevenueUsd, 10000.0);
  assert.equal(est.cogsBreakdown.frontierApiCostUsd, 7.5);
  assert.equal(est.cogsBreakdown.cloudInfraCostUsd, 200.0);
  assert.equal(est.cogsBreakdown.totalCogsUsd, 207.5);
  assert.equal(est.margins.grossMarginUsd, 9792.5);
  assert.equal(est.margins.grossMarginPct, 97.9);
  assert.equal(est.margins.laborReserveUsd, 2000.0);
  assert.equal(est.margins.netContributionUsd, 7792.5);
  assert.equal(est.efficiencyVerdict, 'HIGHLY_PROFITABLE');
  assert.ok(est.margins.unitEconomicMultiplier.includes('x'));
});

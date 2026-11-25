import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, settlementMath, validateDiscount, minDiscountBpsFor, lateFeeFor, bondBpsForTrust, trustTier,
  seatLadderBps, seatDiscountBps, seatNetPreview,
} from '../functions/lib/rules.mjs';

test('every settlement allocates exactly the pot', () => {
  const pots = [20000, 100000, 123456, 250000, 600000];
  const bpsList = [0, 100, 500, 1200, 2500];
  const waiterList = [0, 1, 2, 4, 11];
  const trustList = [20, 50, 70, 90];
  for (const pot of pots) {
    for (const discountBps of bpsList) {
      for (const waiterCount of waiterList) {
        for (const winnerTrust of trustList) {
          for (const organizerWins of [false, true]) {
            for (const isFinal of [false, true]) {
              const math = settlementMath({
                potMinor: pot,
                discountBps,
                organizerWins,
                organizerFeeBps: RULES.defaultOrganizerBps,
                winnerTrust,
                waiterCount,
                isFinal,
              });
              assert.equal(math.totalAllocated, pot, `pot ${pot} bps ${discountBps} waiters ${waiterCount}`);
              assert.ok(math.winnerNetMinor >= 0);
              assert.ok(math.bondHoldMinor >= 0);
              assert.ok(math.bondHoldMinor <= math.bondTargetMinor);
              assert.equal(math.discountMinor + math.platformFeeMinor + math.organizerFeeMinor
                + math.organizerWaivedMinor + math.fundFeeMinor + math.bondHoldMinor + math.winnerNetMinor, pot);
              if (isFinal) {
                assert.equal(math.discountMinor, 0);
                assert.equal(math.bondHoldMinor, 0);
                assert.equal(math.waiterShareMinor, 0);
                assert.equal(math.isFinal, true);
              }
            }
          }
        }
      }
    }
  }
});

test('a regular settlement follows the stated waterfall', () => {
  const math = settlementMath({
    potMinor: 100000,
    discountBps: 1200,
    organizerWins: false,
    organizerFeeBps: 100,
    winnerTrust: 50,
    waiterCount: 4,
    isFinal: false,
  });
  assert.equal(math.discountMinor, 12000);
  assert.equal(math.waiterShareMinor, 3000);
  assert.equal(math.remainderMinor, 0);
  assert.equal(math.platformFeeMinor, 1000);
  assert.equal(math.organizerFeeMinor, 1000);
  assert.equal(math.fundFeeMinor, 1000);
  assert.equal(math.bondTargetMinor, 20000);
  assert.equal(math.bondHoldMinor, 20000);
  assert.equal(math.winnerNetMinor, 65000);
  assert.equal(math.fundCreditMinor, 1000);
  assert.equal(math.totalAllocated, 100000);
});

test('an organizer winner waives their fee into the fund', () => {
  const math = settlementMath({
    potMinor: 100000,
    discountBps: 0,
    organizerWins: true,
    organizerFeeBps: 150,
    winnerTrust: 90,
    waiterCount: 4,
    isFinal: false,
  });
  assert.equal(math.organizerFeeMinor, 0);
  assert.equal(math.organizerWaivedMinor, 1500);
  assert.ok(math.fundCreditMinor >= 1500);
  assert.equal(math.totalAllocated, 100000);
});

test('the bond is capped by the remainder and never overdraws the pot', () => {
  const math = settlementMath({
    potMinor: 20000,
    discountBps: 2500,
    organizerWins: false,
    organizerFeeBps: 150,
    winnerTrust: 20,
    waiterCount: 4,
    isFinal: false,
  });
  assert.equal(math.bondTargetMinor, 5000);
  assert.equal(math.bondHoldMinor, 5000);
  assert.equal(math.winnerNetMinor, 9300);
  assert.equal(math.totalAllocated, 20000);
});

test('discount bounds respect the percentage and the KES 50 floor', () => {
  assert.equal(minDiscountBpsFor(100000), 500);
  assert.equal(minDiscountBpsFor(1000000), 100);
  assert.equal(minDiscountBpsFor(10000), 5000);
  assert.equal(validateDiscount(499, 100000).ok, false);
  assert.equal(validateDiscount(500, 100000).ok, true);
  assert.equal(validateDiscount(2500, 100000).ok, true);
  assert.equal(validateDiscount(2501, 100000).ok, false);
  assert.equal(validateDiscount(100, 100000).ok, false);
  assert.equal(validateDiscount(2500, 10000).ok, false);
});

test('late fees start after the grace window and cap at ten percent', () => {
  const due = Date.now() - 25 * 60 * 60 * 1000;
  const fee = lateFeeFor(20000, new Date(due).toISOString(), Date.now());
  assert.equal(fee, 400);
  const long = lateFeeFor(20000, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), Date.now());
  assert.equal(long, 2000);
  assert.equal(lateFeeFor(20000, new Date().toISOString(), Date.now()), 0);
});

test('bond tiers and trust labels match the rulebook', () => {
  assert.equal(bondBpsForTrust(0), 2500);
  assert.equal(bondBpsForTrust(39), 2500);
  assert.equal(bondBpsForTrust(40), 2000);
  assert.equal(bondBpsForTrust(59), 2000);
  assert.equal(bondBpsForTrust(60), 1500);
  assert.equal(bondBpsForTrust(79), 1500);
  assert.equal(bondBpsForTrust(80), 1000);
  assert.equal(trustTier(20), 'Building');
  assert.equal(trustTier(50), 'Steady');
  assert.equal(trustTier(70), 'Trusted');
  assert.equal(trustTier(90), 'Veteran');
});

test('the seat ladder declines to zero and replaces bidding with posted prices', () => {
  assert.deepEqual(seatLadderBps(5, 500000), [1000, 600, 300, 100, 0]);
  assert.deepEqual(seatLadderBps(12, 600000), [1000, 850, 700, 600, 450, 350, 250, 200, 100, 100, 100, 0]);
  assert.deepEqual(seatLadderBps(5, 100000), [1000, 600, 500, 500, 0], 'the KES 50 floor lifts late seats');
  assert.deepEqual(seatLadderBps(5, 50000), [1000, 1000, 1000, 1000, 0], 'a KES 500 pot floors every seat at 10%');
  for (const turns of [5, 6, 8, 12]) {
    for (const pot of [20000, 60000, 250000, 6000000]) {
      const ladder = seatLadderBps(turns, pot);
      assert.equal(ladder.length, turns);
      assert.equal(ladder.at(-1), 0, 'the final seat pays no discount');
      const floor = Math.max(RULES.minDiscountBps, minDiscountBpsFor(pot));
      assert.equal(ladder[0], Math.min(RULES.maxDiscountBps, Math.max(1000, floor)), 'the first seat pays the base price unless the floor lifts it');
      for (const bps of ladder) {
        assert.ok(bps >= 0 && bps <= RULES.maxDiscountBps);
        if (bps > 0) assert.ok(bps >= floor, `pot ${pot} seat price ${bps} respects the floor`);
      }
      for (let index = 1; index < ladder.length; index += 1) {
        assert.ok(ladder[index] <= ladder[index - 1], 'prices never rise along the ladder');
      }
    }
  }
  assert.equal(seatDiscountBps(5, 2, 500000), 600);
  assert.equal(seatDiscountBps(5, 5, 500000), 0);
  assert.equal(seatDiscountBps(5, 6, 500000), 0, 'a missing seat has no price');
  assert.equal(seatDiscountBps(5, 0, 500000), 0);
});

test('seat previews match the settlement waterfall for the posted price', () => {
  const preview = seatNetPreview(5, 2, 500000, { trust: 50 });
  assert.equal(preview.discountBps, 600);
  assert.equal(preview.discountMinor, 30000);
  assert.equal(preview.waiterCount, 3);
  assert.equal(preview.waiterShareMinor, 10000);
  assert.equal(preview.winnerNetMinor, 355000);
  assert.equal(preview.totalAllocated, 500000);
  const same = settlementMath({
    potMinor: 500000, discountBps: 600, organizerWins: false,
    organizerFeeBps: RULES.defaultOrganizerBps, winnerTrust: 50, waiterCount: 3, isFinal: false,
  });
  assert.deepEqual(preview, same);
  const final = seatNetPreview(5, 5, 500000, { trust: 50 });
  assert.equal(final.discountBps, 0);
  assert.equal(final.bondHoldMinor, 0);
  assert.equal(final.isFinal, true);
  assert.equal(final.winnerNetMinor, 485000);
  const organizer = seatNetPreview(5, 1, 500000, { trust: 50, organizerWins: true });
  assert.equal(organizer.organizerFeeMinor, 0);
  assert.equal(organizer.organizerWaivedMinor, 5000);
});

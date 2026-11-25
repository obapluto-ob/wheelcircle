export const RULES = Object.freeze({
  currency: 'KES',
  timezone: 'Africa/Nairobi',
  platformBps: 100,
  fundBps: 100,
  minDiscountBps: 100,
  maxDiscountBps: 2500,
  minDiscountMinor: 5000,
  maxOrganizerBps: 150,
  defaultOrganizerBps: 100,
  lateFeeBps: 200,
  lateCapBps: 1000,
  graceHours: 24,
  firstPayoutHoldHours: 48,
  bidWindowMinutes: 1440,
  contributionWindowHours: 72,
  cycleDays: 7,
  settleGraceMinutes: 60,
  minMembers: 5,
  maxMembers: 12,
  minContributionMinor: 20000,
  maxContributionMinor: 500000,
  trustMin: 0,
  trustMax: 99,
});

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Nairobi is UTC+3 throughout the year. Work in shifted UTC to avoid host timezone/DST.
export function scheduledTurnAt(startAt, cadence) {
  if (!['weekly', 'fortnightly', 'monthly'].includes(cadence)) throw new RangeError('Invalid cadence');
  const start = startAt instanceof Date ? startAt.getTime()
    : typeof startAt === 'number' ? startAt : typeof startAt === 'string' ? Date.parse(startAt) : NaN;
  if (!Number.isFinite(start)) throw new RangeError('Invalid turn start');
  if (cadence !== 'monthly') return new Date(start + (cadence === 'weekly' ? 7 : 14) * DAY).toISOString();
  const local = new Date(start + 3 * HOUR);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + 1);
  const monthEnd = new Date(local.getTime());
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  local.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return new Date(local.getTime() - 3 * HOUR).toISOString();
}

export function groupCadence(group) {
  if (!group || typeof group !== 'object') return 'weekly';
  if (typeof group.cadence === 'string' && ['weekly', 'fortnightly', 'monthly'].includes(group.cadence)) {
    return group.cadence;
  }
  const cycleDays = Number(group.cycle_days);
  if (cycleDays === 14) return 'fortnightly';
  if (cycleDays === 0) return 'monthly';
  return 'weekly';
}

export function bondBpsForTrust(trust) {
  const value = Number(trust);
  if (value < 40) return 2500;
  if (value < 60) return 2000;
  if (value < 80) return 1500;
  return 1000;
}

export function trustTier(trust) {
  const value = Number(trust);
  if (value < 40) return 'Building';
  if (value < 60) return 'Steady';
  if (value < 80) return 'Trusted';
  return 'Veteran';
}

export function lateFeeFor(contributionMinor, dueAt, now = Date.now()) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return 0;
  const graceEnds = due + RULES.graceHours * HOUR;
  if (now <= graceEnds) return 0;
  const daysLate = Math.ceil((now - graceEnds) / DAY);
  const bps = Math.min(RULES.lateFeeBps * Math.max(1, daysLate), RULES.lateCapBps);
  return Math.round((Number(contributionMinor) * bps) / 10000);
}

export function minDiscountBpsFor(potMinor) {
  const pot = Number(potMinor);
  if (!Number.isFinite(pot) || pot <= 0) return RULES.minDiscountBps;
  return Math.max(RULES.minDiscountBps, Math.ceil((RULES.minDiscountMinor * 10000) / pot));
}

export function validateDiscount(bps, potMinor) {
  const value = Number(bps);
  if (!Number.isInteger(value)) return { ok: false, reason: 'Enter a whole percentage.' };
  const minBps = minDiscountBpsFor(potMinor);
  if (value < minBps) return { ok: false, reason: `The minimum discount for this pot is ${(minBps / 100).toFixed(2)}%.` };
  if (value > RULES.maxDiscountBps) return { ok: false, reason: 'The maximum discount is 25%.' };
  if (Math.floor((Number(potMinor) * value) / 10000) < RULES.minDiscountMinor) {
    return { ok: false, reason: `The discount must be at least KES ${RULES.minDiscountMinor / 100}.` };
  }
  return { ok: true, minBps, value };
}

// The turn is not auctioned: each seat carries a posted price. Seat 1 pays the
// most for speed and the last seat pays nothing, so the ladder replaces bidding.
export const SEAT_LADDER_BASE_BPS = 1000;

export function seatLadderBps(turnsTotal, potMinor = 0) {
  const turns = Math.max(2, Math.floor(Number(turnsTotal) || 0));
  const floor = Math.max(RULES.minDiscountBps, minDiscountBpsFor(potMinor));
  const ladder = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn === turns) { ladder.push(0); continue; }
    const remaining = (turns - turn) / (turns - 1);
    const raw = Math.round((SEAT_LADDER_BASE_BPS * Math.pow(remaining, 1.7)) / 50) * 50;
    ladder.push(Math.min(RULES.maxDiscountBps, Math.max(floor, raw)));
  }
  return ladder;
}

export function seatDiscountBps(turnsTotal, turnNumber, potMinor = 0) {
  const ladder = seatLadderBps(turnsTotal, potMinor);
  const index = Math.floor(Number(turnNumber) || 0) - 1;
  return index >= 0 && index < ladder.length ? ladder[index] : 0;
}

export function seatNetPreview(turnsTotal, turnNumber, potMinor, { trust, organizerWins = false, organizerFeeBps = RULES.defaultOrganizerBps } = {}) {
  return settlementMath({
    potMinor,
    discountBps: seatDiscountBps(turnsTotal, turnNumber, potMinor),
    organizerWins,
    organizerFeeBps,
    winnerTrust: trust,
    waiterCount: Math.max(0, Math.floor(Number(turnsTotal) || 0) - Math.floor(Number(turnNumber) || 0)),
    isFinal: Math.floor(Number(turnNumber) || 0) >= Math.floor(Number(turnsTotal) || 0),
  });
}

export function settlementMath({
  potMinor,
  discountBps,
  organizerWins,
  organizerFeeBps,
  winnerTrust,
  waiterCount,
  isFinal,
}) {
  const pot = Math.max(0, Math.round(Number(potMinor) || 0));
  const final = Boolean(isFinal);
  const waiters = final ? 0 : Math.max(0, Math.floor(Number(waiterCount) || 0));
  let bps = Math.max(0, Math.min(RULES.maxDiscountBps, Math.round(Number(discountBps) || 0)));
  if (final) bps = 0;
  const discount = waiters > 0 ? Math.floor((pot * bps) / 10000) : 0;
  const waiterShare = waiters > 0 ? Math.floor(discount / waiters) : 0;
  const remainder = waiters > 0 ? discount - waiterShare * waiters : 0;
  const platformFee = Math.floor((pot * RULES.platformBps) / 10000);
  const organizerBase = Math.floor((pot * Math.max(0, Math.min(RULES.maxOrganizerBps, Number(organizerFeeBps) || 0))) / 10000);
  const organizerFee = organizerWins ? 0 : organizerBase;
  const organizerWaived = organizerWins ? organizerBase : 0;
  const fundFee = Math.floor((pot * RULES.fundBps) / 10000);
  const fees = platformFee + organizerFee + organizerWaived + fundFee;
  const bondTarget = final ? 0 : Math.round((pot * bondBpsForTrust(winnerTrust)) / 10000);
  const bondHold = final ? 0 : Math.max(0, Math.min(bondTarget, Math.max(0, pot - discount - fees)));
  const winnerNet = Math.max(0, pot - discount - fees - bondHold);
  const fundCredit = fundFee + organizerWaived + remainder;
  return {
    potMinor: pot,
    discountBps: bps,
    discountMinor: discount,
    waiterCount: waiters,
    waiterShareMinor: waiterShare,
    remainderMinor: remainder,
    platformFeeMinor: platformFee,
    organizerFeeMinor: organizerFee,
    organizerWaivedMinor: organizerWaived,
    fundFeeMinor: fundFee,
    fundCreditMinor: fundCredit,
    bondTargetMinor: bondTarget,
    bondHoldMinor: bondHold,
    winnerNetMinor: winnerNet,
    totalAllocated: discount + fees + bondHold + winnerNet,
    isFinal: final,
  };
}

export function firstPayoutHoldMs(isFirstPayout) {
  return isFirstPayout ? RULES.firstPayoutHoldHours * HOUR : 0;
}

export function minSettlementTime(cycle) {
  const closes = Date.parse(cycle.auction_closes_at);
  if (!Number.isFinite(closes)) return Infinity;
  // Null is a legacy obligation: keep its original auction deadline.
  if (cycle.scheduled_settle_at == null) return closes;
  const scheduled = Date.parse(cycle.scheduled_settle_at);
  return Number.isFinite(scheduled) ? Math.max(closes, scheduled) : Infinity;
}

export function effectiveMinBps(cycle) {
  return minDiscountBpsFor(cycle?.pot_captured_minor || 0);
}

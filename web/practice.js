import { createPractice, actPractice, practiceGuide, practiceRecap } from './practice-model.mjs';
import { seatDiscountBps } from './rules.mjs';
import { engineMarkup, mountEngines, speakEngineText, stopEngineVoice } from './engine.js';

const STORE = 'wheel.practice.v3';
const cadenceName = (value) => ({ weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Calendar monthly' }[value]);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cash = (value) => `KES ${(Number(value || 0) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const glyph = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
let model;
let host;
let notice = '';
let question = 'fairness';
let confirmingReset = false;
let storageUnavailable = false;
let speaking = false;
let recapIndex = 0;
let recapTimer = null;
let recapRound = 0;
let simTimer = null;
let simulating = false;

function load() {
  if (model) return;
  model = createPractice();
  let stored;
  try { stored = localStorage.getItem(STORE); }
  catch { storageUnavailable = true; return; }
  if (!stored) return;
  try {
    const saved = JSON.parse(stored);
    const seatId = (id) => /^p[1-6]$/.test(id);
    const valid = saved?.version === 3 && Number.isFinite(saved.virtualHours) && Number.isFinite(Date.parse(saved.clockStart)) && Number.isInteger(saved.round) && saved.round > 0
      && saved.group?.contributionMinor === 50000 && saved.group.maxMembers === 6 && saved.group.organizerFeeBps === 100 && ['weekly', 'fortnightly', 'monthly'].includes(saved.group.cadence) && typeof saved.group.name === 'string' && ['forming', 'active', 'completed'].includes(saved.group.status)
      && Array.isArray(saved.members) && saved.members.length > 0 && saved.members.length <= 6
      && saved.members.every((m, i) => m && Number.isInteger(m.acceptedRound) && m.id === `p${i + 1}` && typeof m.name === 'string' && m.role === (i === 0 ? 'organizer' : 'member') && [m.trustScore, m.balanceMinor, m.bondMinor].every(Number.isFinite) && [m.hasWon, m.paid, m.verified].every((v) => typeof v === 'boolean') && (m.wonTurn === null || Number.isInteger(m.wonTurn)))
      && saved.members.some((m) => m.id === saved.activeMemberId)
      && (saved.cycle === null ? saved.group.status === 'forming' : saved.cycle && Number.isInteger(saved.cycle.number) && ['contributing', 'funded', 'settled'].includes(saved.cycle.status))
      && Array.isArray(saved.receipts) && saved.receipts.every((r) => r && Number.isInteger(r.round) && Number.isInteger(r.turn) && typeof r.claimed === 'boolean' && Number.isFinite(r.releaseAtHour) && seatId(r.winnerId) && typeof r.winnerName === 'string' && ['seat', 'final'].includes(r.reason) && r.math && Number.isFinite(r.math.winnerNetMinor) && Object.values(r.math).every((v) => typeof v === 'boolean' || Number.isFinite(v)))
      && Array.isArray(saved.ledger) && saved.ledger.every((row) => row && Number.isInteger(row.round) && Number.isInteger(row.turn) && Number.isFinite(row.amountMinor) && typeof row.label === 'string');
    if (valid) model = saved;
    else notice = 'The saved practice could not be restored. A fresh circle is ready.';
  } catch { notice = 'The saved practice could not be restored. A fresh circle is ready.'; }
}

function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(model)); }
  catch { storageUnavailable = true; }
}

function button(action, label, { disabled = false, quiet = false, memberId = '' } = {}) {
  return `<button type="button" class="btn ${quiet ? 'btn--line' : 'btn--lime'}" data-practice="${action}"${memberId ? ` data-member="${esc(memberId)}"` : ''}${disabled ? ' disabled' : ''}>${label}</button>`;
}

function currentPage() {
  const page = location.hash.split('/')[2];
  return ['circle', 'turn', 'ledger'].includes(page) ? page : 'circle';
}

function status(member) {
  if (model.group.status === 'forming') return member.acceptedRound === model.round ? 'Round accepted' : 'Acceptance needed';
  if (member.hasWon) return `Paid on turn ${member.wonTurn}`;
  if (!model.cycle) return 'Waiting to start';
  const seat = model.members.indexOf(member) + 1;
  if (!member.paid) return `Contribution due · pays on turn ${seat}`;
  return `Pays on turn ${seat}`;
}

function memberWheel() {
  const count = model.group.status === 'forming' ? model.group.maxMembers : model.members.length;
  const received = model.members.filter((m) => m.hasWon).length;
  return `<div class="practice-wheel" aria-label="Circle seats">
    <div class="practice-wheel__ring" style="--received:${received / count * 100}%"></div>
    <div class="practice-wheel__hub"><span>${model.cycle ? `TURN ${model.cycle.number}` : 'YOUR PRACTICE CIRCLE'}</span><strong>${received}<em> / ${model.members.length}</em></strong><small>members have received</small><b>One pot per person.</b></div>
    ${Array.from({ length: count }, (_, i) => {
      const member = model.members[i];
      const angle = i * 2 * Math.PI / count - Math.PI / 2;
      return `<button type="button" class="practice-seat${member?.id === model.activeMemberId ? ' is-selected' : ''}${member?.hasWon ? ' is-received' : ''}" style="--x:${50 + 40 * Math.cos(angle)}%;--y:${50 + 40 * Math.sin(angle)}%" data-practice="${member ? 'switch' : 'join'}"${member ? ` data-member="${member.id}" aria-pressed="${member.id === model.activeMemberId}"` : ''} aria-label="${member ? `View as ${esc(member.name)}: ${status(member)}` : 'Invite the next practice member'}"><span>${member ? esc(member.name.slice(0, 1)) : '+'}</span><b>${member ? esc(member.name) : 'Invite'}</b><em>${member?.hasWon ? 'RECEIVED' : member ? member.paid ? 'FUNDED' : 'SEAT ' + (i + 1) : 'OPEN'}</em></button>`;
    }).join('')}
  </div>`;
}

function guideText() {
  const me = model.members.find((m) => m.id === model.activeMemberId);
  if (question === 'fairness') return `Turns follow seats. Turn 1 pays seat 1, turn 2 pays seat 2, and the last seat pays no discount at all. Every seat has a posted price, so nobody outbids anyone. Previous winners keep contributing; their turn has passed.`;
  if (question === 'money') return 'All money here is virtual. In a real circle, the pot is funded first. The discount goes to members who have not received yet. Fees and the bond are shown before the winner’s net. A receipt is not proof of an external transfer; verification and the first-payout hold still apply.';
  if (question === 'role') return `You are viewing as ${me.name}, the ${me.role}. ${me.hasWon ? 'You have already received your pot. Keep funding the remaining turns; your turn has passed.' : `Your seat is ${model.members.indexOf(me) + 1}, so this circle pays you on turn ${model.members.indexOf(me) + 1}.`} ${me.role === 'organizer' ? 'You also start turns and verify members.' : 'Only the organizer opens a new turn.'}`;
  return practiceGuide(model).body;
}

function memberCard() {
  const me = model.members.find((m) => m.id === model.activeMemberId);
  const cycle = model.cycle;
  const receipt = model.receipts.find((r) => r.winnerId === me.id && !r.claimed);
  const seat = model.members.indexOf(me) + 1;
  return `<section class="card practice-person">
    <div class="card__head"><h2 class="card__title">Your seat</h2><span class="pill pill--live">${esc(me.role)}</span></div>
    <label class="field"><span>View the experience as</span><select class="input" data-practice-member aria-label="Practice member">${model.members.map((m) => `<option value="${m.id}"${m.id === me.id ? ' selected' : ''}>${esc(m.name)} · ${m.role}${m.hasWon ? ' · received' : ''}</option>`).join('')}</select></label>
    <p class="practice-person__status">${glyph(me.hasWon ? 'check' : 'circle')} ${status(me)}</p>
    <div class="practice-balances"><div><span>Virtual credits</span><b>${cash(me.balanceMinor)}</b></div><div><span>Bond held</span><b>${cash(me.bondMinor)}</b></div></div>
    ${cycle ? `<p>Everyone pays ${cash(model.group.contributionMinor)} each turn, winners included. Turn ${cycle.number} pays seat ${cycle.number} at ${seatDiscountBps(model.members.length, cycle.number, model.members.length * model.group.contributionMinor) / 100}% the moment the pot is whole.</p>${cycle.status === 'contributing' ? button('pay', me.paid ? 'Your contribution is in' : `Pay ${cash(model.group.contributionMinor)} virtually`, { disabled: me.paid }) : ''}${me.hasWon ? `<div class="notice">${glyph('lock')}<span>Your seat was paid on turn ${me.wonTurn}. You keep contributing until the circle closes.</span></div>` : `<p>Your seat is ${seat}. The wheel pays seat ${seat} on turn ${seat}; there is no bidding and no waiting window.</p>`}` : `<p>Try every role without creating accounts. Choose a name above or tap a seat on the wheel.</p>`}
    ${receipt ? `<div class="practice-pending"><b>Pending virtual payout · ${cash(receipt.math.winnerNetMinor)}</b><p>${me.verified ? 'Identity verified in practice.' : 'Practice identity check needed.'} ${model.virtualHours < receipt.releaseAtHour ? `${receipt.releaseAtHour - model.virtualHours} simulated hours remain.` : 'The hold has ended.'}</p>${button('claim', receipt.claimed ? 'Claimed' : 'Claim virtual payout', { disabled: !me.verified || model.virtualHours < receipt.releaseAtHour })}${model.virtualHours < receipt.releaseAtHour ? button('hold', 'Fast-forward the 48h hold', { quiet: true }) : ''}</div>` : ''}
  </section>`;
}

function circlePanel() {
  const forming = model.group.status === 'forming';
  const me = model.members.find((m) => m.id === model.activeMemberId);
  const accepted = model.members.filter((m) => m.acceptedRound === model.round).length;
  return `<section class="card practice-circle">
    <div class="card__head"><h2 class="card__title">${esc(model.group.name)} · round ${model.round}</h2><span class="pill">${forming ? 'REVIEW TERMS' : model.group.status === 'completed' ? 'COMPLETE' : 'IN PROGRESS'}</span></div>
    ${memberWheel()}
    <div class="practice-legend"><span>Tap a seat to switch member</span><span>${glyph('check')} One allocation per round</span></div>
    ${forming ? `<div class="round-terms">
      <label class="field"><span>Circle period</span><select class="select" data-practice-cadence ${me.role !== 'organizer' || model.round > 1 ? 'disabled' : ''}>${['weekly', 'fortnightly', 'monthly'].map((value) => `<option value="${value}"${model.group.cadence === value ? ' selected' : ''}>${cadenceName(value)}</option>`).join('')}</select></label>
      <p>${cash(model.group.contributionMinor)} per member every turn · ${model.members.length} turns if started now · ${cash(model.group.contributionMinor * model.members.length)} total commitment per member.</p>
      <p class="hint">The same members stay together for another round only after everyone accepts again. Each pot must be funded; no automatic founder top-ups or guaranteed profit. Platform 1%, organizer 1%, fund 1%, plus the winner’s discount and held bond.</p>
      <div class="practice-actions">${button('accept', me.acceptedRound === model.round ? 'You accepted this round' : 'Accept round terms', { disabled: me.acceptedRound === model.round })}${button('accept-others', 'Simulate other acceptances', { quiet: true, disabled: model.members.every((m) => m.id === me.id || m.acceptedRound === model.round) })}</div>
      <p class="hint">${accepted}/${model.members.length} accepted · Every real member must accept personally.</p>
    </div>` : ''}
    <div class="practice-actions">${forming ? `${model.round === 1 ? button('join', 'Invite next member', { quiet: true, disabled: model.members.length >= model.group.maxMembers }) : ''}${button('start', 'Start circle', { disabled: model.members.length < 5 || me.role !== 'organizer' || accepted !== model.members.length })}` : `<a class="btn btn--${model.group.status === 'completed' ? 'line' : 'lime'}" href="#/practice/turn">${model.group.status === 'completed' ? 'See the last receipt' : 'Open this turn'} ${glyph('arrow')}</a>`}</div>
  </section>
  ${model.group.status === 'completed' ? recapPanel() : ''}
  <section class="card practice-members"><div class="card__head"><h2 class="card__title">Your lasting group</h2><span class="pill">${cadenceName(model.group.cadence)}</span></div>${model.members.map((m) => `<div class="practice-member"><button type="button" data-practice="switch" data-member="${m.id}" aria-label="View as ${esc(m.name)}"><span class="avatar">${esc(m.name[0])}</span><span><b>${esc(m.name)}</b><small>${status(m)} · ${m.verified ? 'Verified' : 'Not verified'}</small></span></button>${me.role === 'organizer' ? button('verify', m.verified ? 'Verified' : 'Verify', { memberId: m.id, disabled: m.verified, quiet: true }) : ''}</div>`).join('')}<p class="hint">Verification here is a learning action, not a real identity check.</p></section>`;
}

function receiptPanel(receipt) {
  const math = receipt.math;
  const rows = [['Funded pot', math.potMinor], ['Discount to waiting members', -math.discountMinor], ['Platform · 1%', -math.platformFeeMinor], ['Organizer fee', -math.organizerFeeMinor], ['Organizer fee waived to fund', -math.organizerWaivedMinor], ['Circle fund · 1%', -math.fundFeeMinor], ['Bond held', -math.bondHoldMinor]];
  return `<section class="card practice-receipt"><div class="card__head"><h2 class="card__title">Round ${receipt.round} · turn ${receipt.turn} receipt</h2><span class="pill pill--lime">RECORDED</span></div><h2>${esc(receipt.winnerName)} was paid this turn.</h2><p>${receipt.reason === 'final' ? 'The last seat takes the final pot at 0% discount with no bond.' : `Turn ${receipt.turn} belongs to seat ${receipt.turn}, so this seat carried the posted price of ${math.discountBps / 100}%.`}</p><div class="practice-receipt__rows">${rows.map(([label, value]) => `<div><span>${label}</span><b>${value < 0 ? '− ' : ''}${cash(Math.abs(value))}</b></div>`).join('')}<div class="practice-receipt__total"><span>Winner net · virtual</span><b>${cash(math.winnerNetMinor)}</b></div></div><p class="hint">${math.waiterCount} waiting members receive ${cash(math.waiterShareMinor)} each. ${receipt.claimed ? 'Virtual payout claimed.' : 'Net stays pending until practice verification and the first-payout hold are complete.'}</p><details class="practice-proof"><summary>Why this seat?</summary><p>Each seat carries a posted price. Seat 1 pays the most for going first and the last seat pays nothing. Nobody bids, nobody is drawn at random, and the contribution that closes the pot settles the turn on the spot.</p></details></section>`;
}

function stopRecap() {
  if (recapTimer) clearInterval(recapTimer);
  recapTimer = null;
}

function recapSpeech(recap, turn) {
  const fees = turn.platformFeeMinor + turn.organizerFeeMinor + turn.organizerWaivedMinor + turn.fundFeeMinor;
  const parts = [`Turn ${turn.number} of ${recap.turnsTotal}. ${turn.winnerName} received ${cash(turn.winnerNetMinor)} net from a pot of ${cash(turn.potMinor)}.`];
  if (turn.reason === 'final') parts.push('Final turn: zero discount and no bond.');
  else parts.push(`Turn ${turn.number} belongs to seat ${turn.number}, so it carried a ${turn.discountBps / 100} percent discount, with ${cash(turn.waiterShareMinor)} going to each of ${turn.waiterCount} waiting members.`);
  if (turn.bondHeldMinor) parts.push(`${cash(turn.bondHeldMinor)} bond held, then returned as the circle kept funding.`);
  parts.push(`Fees and fund came to ${cash(fees)}. This is virtual practice money; no real payout was made.`);
  return parts.join(' ');
}

function speakRecapTurn(recap, index) {
  const turn = recap.turns[index];
  if (!turn) return;
  speakEngineText(recapSpeech(recap, turn), (reason) => {
    if (reason !== 'ended' && reason !== 'stopped') {
      const output = host?.querySelector('.practice-feedback');
      if (output) output.textContent = 'Voice could not play on this device. The recap stays readable as text.';
    }
  });
}

function recapPanel() {
  const recap = practiceRecap(model);
  if (!recap) return '';
  const last = recap.turns.length - 1;
  recapIndex = Math.max(0, Math.min(last, recapIndex));
  const turn = recap.turns[recapIndex];
  const totals = recap.totals;
  const playing = Boolean(recapTimer);
  const me = recap.members.find((member) => member.id === model.activeMemberId);
  const toMembers = totals.winnerNetMinor + totals.discountMinor + totals.bondReturnedMinor;
  const members = [...recap.members].sort((a, b) => a.seat - b.seat);
  const reason = turn.reason === 'final' ? 'Final turn · 0% discount, no bond' : `Seat ${turn.number} price · ${turn.discountBps / 100}%`;
  return `<section class="card practice-recap" id="recap" aria-label="Round ${recap.round} recap">
    <div class="card__head"><h2 class="card__title">Round ${recap.round} recap</h2><span class="pill pill--lime">COMPLETE</span></div>
    <p class="practice-recap__lead">${recap.members.length} seats funded ${recap.turnsTotal} turns of ${cash(model.group.contributionMinor)} each. Replay every turn and check what each member paid and received before deciding on another round.</p>
    <div class="practice-recap__stats">
      <div><span>POTS SETTLED</span><b>${recap.turnsTotal}</b></div>
      <div><span>TO MEMBERS</span><b class="is-lime">${cash(toMembers)}</b></div>
      <div><span>FEES &amp; FUND</span><b>${cash(totals.feesMinor)}</b></div>
      <div><span>VIRTUAL PENDING</span><b class="is-cyan">${cash(totals.pendingMinor)}</b></div>
    </div>
    <div class="practice-recap__strip" role="tablist" aria-label="Turns">${recap.turns.map((item, index) => `<button type="button" class="practice-recap__chip${index === recapIndex ? ' is-active' : ''}${item.reason === 'final' ? ' is-final' : ''}" role="tab" aria-selected="${index === recapIndex}" data-practice="recap-turn" data-turn="${item.number}"><span>T${item.number}</span><b>${esc(item.winnerName)}</b><em>${item.reason === 'final' ? 'FINAL' : `${item.discountBps / 100}%`}</em></button>`).join('')}</div>
    <div class="practice-recap__turn">
      <div class="practice-recap__head"><div><span>TURN ${turn.number} OF ${recap.turnsTotal}${turn.reason === 'final' ? ' · FINAL' : ''}</span><b>${esc(turn.winnerName)} received the pot</b><small>${reason}</small></div><div class="practice-recap__net"><span>WINNER NET</span><b>${cash(turn.winnerNetMinor)}</b></div></div>
      <div class="practice-receipt__rows">
        <div><span>Funded pot</span><b>${cash(turn.potMinor)}</b></div>
        ${turn.discountMinor ? `<div><span>Discount to ${turn.waiterCount} waiting member${turn.waiterCount === 1 ? '' : 's'}</span><b>− ${cash(turn.discountMinor)}</b></div>` : ''}
        <div><span>Platform fee · 1%</span><b>− ${cash(turn.platformFeeMinor)}</b></div>
        <div><span>Organizer fee</span><b>${turn.organizerWaivedMinor ? `− ${cash(turn.organizerWaivedMinor)} · waived to fund` : `− ${cash(turn.organizerFeeMinor)}`}</b></div>
        <div><span>Circle fund · 1%</span><b>− ${cash(turn.fundFeeMinor)}</b></div>
        ${turn.bondHeldMinor ? `<div><span>Bond held from the winner</span><b>− ${cash(turn.bondHeldMinor)}</b></div>` : ''}
        <div class="practice-receipt__total"><span>Winner net · virtual</span><b>${cash(turn.winnerNetMinor)}</b></div>
      </div>
      <p class="practice-recap__narrative">${esc(recapSpeech(recap, turn))}</p>
      <div class="practice-recap__controls">
        <button type="button" class="btn btn--line" data-practice="recap-prev"${recapIndex === 0 ? ' disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--lime" data-practice="${playing ? 'recap-stop' : 'recap-play'}">${playing ? 'Pause replay' : recapIndex >= last ? 'Replay from turn 1' : 'Play replay'}</button>
        <button type="button" class="btn btn--line" data-practice="recap-next"${recapIndex >= last ? ' disabled' : ''}>Next</button>
        <button type="button" class="btn btn--line" data-practice="recap-speak"${'speechSynthesis' in window ? '' : ' disabled'}>Read this turn</button>
      </div>
    </div>
    <div class="practice-recap__members">
      <div class="practice-recap__members-head"><span>MEMBER</span><span>PAID IN</span><span>DISCOUNTS</span><span>RECEIVED</span><span>NET</span></div>
      ${members.map((member) => `<div class="practice-recap__member${member.id === me?.id ? ' is-me' : ''}">
        <span class="practice-recap__who"><b>${esc(member.name)}${member.id === me?.id ? ' · you' : ''}</b><small>${member.role === 'organizer' ? 'Organizer' : 'Member'} · seat ${member.seat}${member.bondReturnedMinor ? ` · bond ${cash(member.bondReturnedMinor)} back` : ''}${member.pendingMinor ? ` · ${cash(member.pendingMinor)} pending` : ''}</small></span>
        <span data-label="Paid in">${cash(member.paidMinor)}</span>
        <span data-label="Discounts">${cash(member.discountsMinor)}</span>
        <span data-label="Received">${member.receivedTurn ? `${cash(member.receivedMinor)}<em>T${member.receivedTurn}</em>` : '<em>Still waiting</em>'}</span>
        <b data-label="Net" class="${member.netMinor >= 0 ? 'is-lime' : ''}">${member.netMinor < 0 ? '− ' : '+ '}${cash(Math.abs(member.netMinor))}</b>
      </div>`).join('')}
      <p class="practice-recap__note">Net = pot received + discount shares + bond returned − contributions paid. Pending virtual payouts still need the practice identity check and the 48h first-payout hold. Virtual money only.</p>
    </div>
    <div class="practice-recap__assure">
      <div><b>Every pot balances</b><span>${recap.balanced ? 'Each receipt allocates the declared pot to the shilling.' : 'A receipt does not balance. Treat this record with care.'}</span></div>
      <div><b>One pot per member</b><span>${recap.members.every((member) => member.receivedTurn) ? 'Every seat received exactly once this round.' : 'At least one seat did not receive this round.'}</span></div>
      <div><b>Bonds came back</b><span>${cash(totals.bondReturnedMinor)} returned across the round as winners kept funding.</span></div>
    </div>
    <div class="practice-recap__cta">${me.role === 'organizer' ? button('renew', `Propose round ${recap.round + 1}`) : '<span class="hint">The organizer proposes the next round. Everyone must accept again.</span>'}<a class="btn btn--line" href="#/practice/ledger">Receipts &amp; money trail ${glyph('arrow')}</a></div>
  </section>`;
}

function handleRecap(action, target) {
  const recap = practiceRecap(model);
  if (!recap) { stopRecap(); render(); return; }
  const last = recap.turns.length - 1;
  stopVoice();
  if (action === 'recap-prev') { stopRecap(); recapIndex = Math.max(0, recapIndex - 1); }
  else if (action === 'recap-next') { stopRecap(); recapIndex = Math.min(last, recapIndex + 1); }
  else if (action === 'recap-turn') {
    stopRecap();
    const index = recap.turns.findIndex((turn) => turn.number === Number(target.dataset.turn));
    if (index >= 0) recapIndex = index;
  } else if (action === 'recap-play') {
    stopRecap();
    recapIndex = recapIndex >= last ? 0 : recapIndex + 1;
    speakRecapTurn(recap, recapIndex);
    if (recapIndex < last) {
      recapTimer = setInterval(() => {
        const current = practiceRecap(model);
        if (!current || recapIndex >= current.turns.length - 1) { stopRecap(); render(); return; }
        recapIndex += 1;
        speakRecapTurn(current, recapIndex);
        render();
      }, 2800);
    }
  } else if (action === 'recap-stop') {
    stopRecap();
  } else if (action === 'recap-speak') {
    stopRecap();
    speakRecapTurn(recap, recapIndex);
    return;
  }
  render();
}

function turnPanel() {
  const cycle = model.cycle;
  if (!cycle) return `<section class="card"><h2>No turn yet.</h2><p>Gather at least five seats, then the organizer can start the circle.</p><a class="btn btn--lime" href="#/practice/circle">Gather your circle</a></section>`;
  const funded = model.members.filter((m) => m.paid).length;
  const me = model.members.find((m) => m.id === model.activeMemberId);
  const receipt = model.receipts.find((r) => r.round === model.round && r.turn === cycle.number);
  const pot = model.members.length * model.group.contributionMinor;
  const seatPrice = seatDiscountBps(model.members.length, cycle.number, pot);
  const owner = model.members[cycle.number - 1];
  const engine = engineMarkup({ key: `practice-${model.clockStart}-${model.round}-${cycle.number}`, phase: cycle.status === 'settled' ? 'settled' : 'contributing', paid: funded, total: model.members.length, potMinor: funded * model.group.contributionMinor, round: model.round, turn: cycle.number, winnerName: receipt?.winnerName, winnerNetMinor: receipt?.math.winnerNetMinor, virtual: true });
  const actions = cycle.status === 'contributing'
    ? button('fund-others', simulating ? 'Contributions arriving…' : 'Simulate other contributions', { quiet: true, disabled: simulating || model.members.every((m) => m.id === me.id || m.paid) })
    : model.group.status !== 'completed'
      ? button('next', 'Open next turn', { disabled: me.role !== 'organizer' })
      : '<a class="btn btn--lime" href="#/practice/circle">Open the round recap</a>';
  const hint = cycle.status === 'contributing'
    ? `The turn pays the instant the pot is whole. Seat ${cycle.number} is the owner of this turn.`
    : 'Everyone keeps funding until every member has received once. Only the organizer opens the next turn.';
  return `${engine}<section class="card practice-turn"><div class="card__head"><h2 class="card__title">Round ${model.round} · turn ${cycle.number}/${model.members.length}</h2><span class="pill">${cycle.isFinal ? 'FINAL TURN' : esc(cycle.status.toUpperCase())}</span></div><div class="practice-pot"><span>${cycle.status === 'contributing' ? 'FUNDING THE POT' : 'POT RECORDED · VIRTUAL'}</span><strong>${cash(funded * model.group.contributionMinor)}</strong><small>${funded}/${model.members.length} contributions · ${cash(model.group.contributionMinor)} each</small></div><div class="round-schedule"><b>Turn ${cycle.number} belongs to seat ${cycle.number}${owner ? ` · ${esc(owner.name)}` : ''}</b><span>Seat price ${seatPrice / 100}% · ${cash(Math.floor((pot * seatPrice) / 10000))} to waiting members</span><p>No bids, no window. The contribution that makes the pot whole pays the seat immediately.</p></div><div class="practice-funding" aria-label="Contribution progress">${model.members.map((m) => `<button type="button" class="${m.paid ? 'is-paid' : ''}" data-practice="switch" data-member="${m.id}">${esc(m.name)}<b>${m.paid ? 'Paid' : 'Due'}</b></button>`).join('')}</div><div class="practice-actions">${actions}</div><p class="hint">${hint}</p></section>${receipt ? receiptPanel(receipt) : `<section class="card practice-eligibility"><h2>Who is waiting?</h2><div class="practice-eligibility__list">${model.members.map((m, i) => `<span class="${m.hasWon ? 'is-received' : ''}">${esc(m.name)} <b>${m.hasWon ? `Paid on turn ${m.wonTurn}` : `Seat ${i + 1} · pays on turn ${i + 1}`}</b></span>`).join('')}</div><p>Already received? You still contribute. Your turn has passed, so later discounts skip you. The last seat takes 0% with no bond.</p></section>`}`;
}

function ledgerPanel() {
  return `<section class="card practice-history"><div class="card__head"><h2 class="card__title">Circle record</h2><span class="pill">VIRTUAL MONEY ONLY</span></div><p>${model.receipts.length} pots recorded across ${model.round} round${model.round === 1 ? '' : 's'}. This history never changes your real wallet.</p>${model.receipts.length ? `<div class="practice-winners">${model.receipts.map((r) => `<div><span>ROUND ${r.round} · TURN ${r.turn}</span><b>${esc(r.winnerName)}</b><small>${cash(r.math.winnerNetMinor)} net · ${r.math.discountBps / 100}%</small></div>`).join('')}</div>` : '<p>Fund and settle a turn to see its receipt here.</p>'}</section>${[...model.receipts].reverse().map(receiptPanel).join('')}<section class="card practice-journal"><h2>Money trail</h2>${model.ledger.length ? `<div class="practice-journal__rows">${[...model.ledger].reverse().map((row) => `<div><span><b>${esc(row.label)}</b><small>Round ${row.round} · turn ${row.turn}${row.memberId ? ` · ${esc(model.members.find((m) => m.id === row.memberId)?.name || '')}` : ''}</small></span><strong>${cash(row.amountMinor)}</strong></div>`).join('')}</div>` : '<p>Your first practice contribution will appear here.</p>'}</section>`;
}

function stepRail() {
  const steps = [
    ['Gather five seats', model.members.length >= 5],
    ['Agree terms and start', model.group.status !== 'forming'],
    ['Fund and settle a pot', model.receipts.length > 0],
    ['Read the record', model.group.status === 'completed'],
  ];
  const current = steps.findIndex(([, done]) => !done);
  const items = steps
    .map(([label, done], index) => `<li class="${done ? 'is-done' : index === current ? 'is-now' : ''}"><b>${String(index + 1).padStart(2, '0')}</b><span>${label}</span></li>`)
    .join('');
  return `<ol class="practice-steps" aria-label="Practice flow">${items}</ol>`;
}

function render() {
  if (!host) return;
  if (recapRound !== model.round) {
    stopRecap();
    recapIndex = 0;
    recapRound = model.round;
  }
  const page = currentPage();
  const guide = practiceGuide(model);
  host.dataset.page = page;
  const guideSimulating = guide.action === 'fund-others' && simulating;
  const guideControl = guide.action
    ? button(guide.action, guideSimulating ? 'Contributions arriving…' : esc(guide.label), { disabled: guideSimulating })
    : guide.key.startsWith('organizer-') ? button('switch', 'View as Amina', { memberId: 'p1' })
    : `<a class="btn btn--line" href="#/practice/${guide.page || 'circle'}">Review record ${glyph('arrow')}</a>`;
  host.innerHTML = `<header class="practice-header"><a class="brand" href="#/" aria-label="THE WHEEL home"><span class="brand__mark">${glyph('wheel')}</span><span class="brand__type">THE WHEEL<em>LEARN BY DOING</em></span></a><a class="btn btn--line" href="#/app">Exit practice ${glyph('arrow')}</a></header>
    <main class="practice-main"><div class="practice-banner"><span class="pill pill--live">PRACTICE MODE</span><p>Virtual money. No deposits, withdrawals or real account changes.</p><button type="button" data-practice="reset-prompt">Start over</button></div>
    ${stepRail()}
    ${confirmingReset ? `<section class="practice-reset" role="alert"><p>Reset only this practice circle? Your real account is untouched.</p>${button('reset', 'Reset practice')}${button('reset-cancel', 'Keep learning', { quiet: true })}</section>` : ''}
    <div class="practice-title"><div><p class="eyebrow">YOUR CIRCLE, UNDERSTOOD</p><h1>${page === 'circle' ? 'Your practice circle.' : page === 'ledger' ? 'Every shilling, recorded.' : model.cycle ? `Turn ${model.cycle.number}. Everyone counts.` : 'Your first turn awaits.'}</h1></div><p>Same rules. Room to explore.<br>Switch seats, fund the pot and follow every shilling.</p></div>
    <section class="practice-guide" aria-label="Next step"><span class="practice-guide__orb" aria-hidden="true">${glyph('wheel')}</span><div><span class="eyebrow">NURU · SET-UP GUIDE · ${model.group.status === 'completed' ? 'CIRCLE COMPLETE' : 'NEXT STEP'}</span><h2>${esc(guide.title)}</h2><p>${esc(guide.body)}</p></div>${guideControl}</section>
    <nav class="practice-tabs" aria-label="Practice pages">${[['circle', 'users', 'Circle & members'], ['turn', 'spin', 'This turn'], ['ledger', 'ledger', 'Receipts & record']].map(([key, ico, label]) => `<a href="#/practice/${key}"${page === key ? ' aria-current="page"' : ''}>${glyph(ico)}<span>${label}</span></a>`).join('')}</nav>
    <p class="practice-feedback" role="status" aria-live="polite">${esc(notice || 'Choose any seat to experience that member’s view.')}</p>
    <div class="practice-layout"><div class="practice-content">${page === 'circle' ? circlePanel() : page === 'turn' ? turnPanel() : ledgerPanel()}</div><aside class="practice-sidebar">${memberCard()}<section class="card practice-coach"><div class="card__head"><h2 class="card__title">A little clarity</h2>${glyph('shield')}</div><div class="practice-questions">${[['fairness', 'Can someone win twice?'], ['money', 'Where does the money go?'], ['role', 'What can I do?'], ['next', 'What happens next?']].map(([key, label]) => `<button type="button" data-question="${key}" aria-pressed="${question === key}">${label}</button>`).join('')}</div><p data-guide-answer>${esc(guideText())}</p><button class="btn btn--line btn--block" type="button" data-practice="speak"${'speechSynthesis' in window ? '' : ' disabled'}>${speaking ? 'Stop reading' : 'Read this aloud'}</button><small>${'speechSynthesis' in window ? 'Optional device voice · no microphone. Voice availability varies by browser.' : 'Device speech is unavailable here. All guidance is shown as text.'} This is a rule-based guide, not financial advice or an AI decision-maker.</small></section></aside></div>
    <footer class="practice-footer">${storageUnavailable ? 'Storage is unavailable; this practice lasts until you reload.' : 'Progress is saved only in this browser.'} · The real service still requires verified identity and connected payments.</footer></main>`;
  host.onclick = onClick;
  const activeChip = host.querySelector('.practice-recap__chip.is-active');
  if (activeChip) {
    const strip = activeChip.parentElement;
    strip.scrollLeft = Math.max(0, activeChip.offsetLeft - strip.clientWidth / 2 + activeChip.clientWidth / 2);
  }
  host.onchange = (event) => {
    if (event.target.matches('[data-practice-member]')) run('switch', { memberId: event.target.value });
    else if (event.target.matches('[data-practice-cadence]')) run('cadence', { cadence: event.target.value });
  };
  mountEngines(host);
}

function stopVoice() {
  stopEngineVoice();
  speaking = false;
}

function stopSimulation() {
  if (simTimer) { clearTimeout(simTimer); simTimer = null; }
  simulating = false;
}

// Other seats fund one at a time so the engine climbs in view, like people
// actually arriving, instead of the pot snapping to full in one frame.
function simulateOthers() {
  if (simulating) return;
  const me = model.members.find((entry) => entry.id === model.activeMemberId);
  if (!me || !model.members.some((entry) => entry.id !== me.id && !entry.paid)) return;
  simulating = true;
  const step = () => {
    simTimer = null;
    if (currentPage() !== 'turn' || !model.cycle || model.cycle.status !== 'contributing') {
      simulating = false;
      return;
    }
    try {
      notice = actPractice(model, 'fund-one', {});
      globalThis.WheelSound?.play?.('money', { pan: 0 });
      persist();
      render();
    } catch (error) {
      simulating = false;
      notice = error.message || 'That action could not be completed.';
      render();
      return;
    }
    if (model.cycle.status === 'contributing') simTimer = setTimeout(step, 620);
    else simulating = false;
  };
  step();
}

function run(action, payload = {}) {
  stopVoice();
  stopRecap();
  try {
    notice = actPractice(model, action, payload);
    const cue = { pay: 'money', 'fund-others': 'money', next: 'ratchet', start: 'seal', switch: 'tick', cadence: 'servo', reset: 'latch' }[action];
    if (cue) globalThis.WheelSound?.play?.(cue, { pan: 0 });
    persist();
    const next = ['start', 'next', 'pay', 'fund-others'].includes(action) ? 'turn' : null;
    if (next && currentPage() !== next) location.hash = `#/practice/${next}`;
    render();
  } catch (error) {
    notice = error.message || 'That action could not be completed.';
    globalThis.WheelSound?.play?.('error', { pan: 0 });
    const output = host.querySelector('.practice-feedback');
    if (output) { output.textContent = notice; output.setAttribute('role', 'alert'); }
  }
}

function onClick(event) {
  const questionButton = event.target.closest('[data-question]');
  if (questionButton) { stopVoice(); question = questionButton.dataset.question; render(); return; }
  const target = event.target.closest('[data-practice]');
  if (!target || target.disabled) return;
  const action = target.dataset.practice;
  if (action === 'reset-prompt' || action === 'reset-cancel') { confirmingReset = action === 'reset-prompt'; render(); return; }
  if (action === 'reset') { stopVoice(); stopRecap(); stopSimulation(); model = createPractice(); recapRound = 0; recapIndex = 0; persist(); confirmingReset = false; notice = 'A fresh practice circle is ready.'; location.hash = '#/practice/circle'; render(); return; }
  if (action === 'fund-others') { simulateOthers(); return; }
  if (action === 'speak') {
    if (speaking) { stopVoice(); render(); return; }
    globalThis.WheelSound?.play?.('consult', { pan: 0 });
    const started = speakEngineText(guideText(), (reason) => {
      speaking = false;
      const b = host?.querySelector('[data-practice="speak"]');
      if (b) b.textContent = 'Read this aloud';
      if (reason !== 'ended' && reason !== 'stopped') {
        const output = host?.querySelector('.practice-feedback');
        if (output) output.textContent = 'Voice could not play on this device. The explanation is shown as text.';
      }
    });
    if (started) { speaking = true; target.textContent = 'Stop reading'; }
    return;
  }
  if (action.startsWith('recap-')) { handleRecap(action, target); return; }
  run(action, { memberId: target.dataset.member });
}

export function renderPractice(container) {
  load();
  host = container;
  stopSimulation();
  stopVoice();
  stopRecap();
  render();
}

export function leavePractice() {
  stopVoice();
  stopRecap();
  stopSimulation();
  host = null;
}

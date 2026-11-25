// Seeds a realistic six-member circle through the public HTTP API for browser checks.
// Usage: PORT=8099 node dev/seed.mjs
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8099}`;

function jar() {
  const cookies = new Map();
  return {
    absorb(response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const at = pair.indexOf('=');
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    },
    header() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    value(name) { return cookies.get(name); },
  };
}

async function call(session, path, options = {}) {
  const headers = { cookie: session.jar.header() };
  if (options.method && options.method !== 'GET') headers.origin = origin;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = session.jar.value('wheel_csrf');
  if (csrf && options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${origin}/functions/v1/app${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  session.jar.absorb(response);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} → ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function login(name, phone) {
  const session = { jar: jar() };
  const response = await fetch(`${origin}/dev/login?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`, {
    redirect: 'manual',
  });
  session.jar.absorb(response);
  session.user = await call(session, '/auth/me');
  return session;
}

async function main() {
  await fetch(`${origin}/dev/reset`, { method: 'POST' });

  const organizer = await login('Amina Wanjiru', '0700000001');
  const others = [];
  for (const [name, phone] of [
    ['Brian Otieno', '0700000002'],
    ['Cynthia Achieng', '0700000003'],
    ['David Kimani', '0700000004'],
    ['Esther Njeri', '0700000005'],
    ['Farid Hassan', '0700000006'],
  ]) others.push(await login(name, phone));
  const everyone = [organizer, ...others];

  const created = await call(organizer, '/groups', {
    method: 'POST',
    body: { name: 'Kilimani Table', contributionMinor: 100000, maxMembers: 6, organizerFeeBps: 100 },
  });
  const gid = created.group.id;
  for (const member of others) {
    await call(member, '/groups/join', { method: 'POST', body: { inviteCode: created.group.inviteCode } });
  }
  await call(organizer, `/groups/${gid}/start`, { method: 'POST', body: {} });
  let detail = await call(organizer, `/groups/${gid}`);
  let cycleId = detail.cycle.id;

  const paid = await fetch(`${origin}/dev/pay-all?cycle=${cycleId}`, { method: 'POST' });
  if (!paid.ok) throw new Error(`pay-all failed: ${paid.status}`);

  const bid = (session, discountBps, isPass = false) => call(session, `/groups/${gid}/cycles/${cycleId}/bids`, {
    method: 'POST',
    body: { discountBps, isPass, idempotencyKey: crypto.randomUUID() },
  });
  await bid(everyone[4], 900);
  await bid(everyone[1], 700);
  await bid(everyone[2], 500);
  await bid(everyone[0], 0, true);
  await bid(everyone[3], 0, true);
  await bid(everyone[5], 0, true);

  await fetch(`${origin}/dev/close-auction?cycle=${cycleId}`, { method: 'POST' });
  await call(organizer, `/groups/${gid}/cycles/${cycleId}/close`, { method: 'POST', body: {} });

  const next = await call(organizer, `/groups/${gid}/cycles`, { method: 'POST', body: {} });
  cycleId = next.cycleId;
  const paidNext = await fetch(`${origin}/dev/pay-all?cycle=${cycleId}`, { method: 'POST' });
  if (!paidNext.ok) throw new Error(`pay-all turn 2 failed: ${paidNext.status}`);
  const bidsTurn2 = [[others[0], 600], [others[1], 0], [others[2], 0], [others[4], 0], [organizer, 0]];
  for (const [session, discountBps] of bidsTurn2) {
    await call(session, `/groups/${gid}/cycles/${cycleId}/bids`, {
      method: 'POST',
      body: { discountBps, isPass: discountBps === 0, idempotencyKey: crypto.randomUUID() },
    });
  }

  detail = await call(organizer, `/groups/${gid}`);
  console.log(JSON.stringify({
    groupId: gid,
    inviteCode: created.group.inviteCode,
    turn: detail.cycle.number,
    status: detail.cycle.status,
    pot: detail.cycle.potCapturedMinor,
    logins: [
      `${origin}/dev/login?name=${encodeURIComponent('Amina Wanjiru')}&phone=0700000001`,
      `${origin}/dev/login?name=${encodeURIComponent('Brian Otieno')}&phone=0700000002`,
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

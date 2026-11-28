// POST /api/access  { idToken, machine }
// Returns this account's trial / paid-until dates as a signed access pass.
// A new account gets its 3-day free trial here.
const { handler, readBody, send, userFromIdToken, getOrCreateAccount, signPass } = require('./_lib/core');

module.exports = handler(async (req, res) => {
  const { json } = await readBody(req);
  const { uid, email } = await userFromIdToken(json.idToken);
  const machine = typeof json.machine === 'string' ? json.machine.slice(0, 200) : '';
  const account = await getOrCreateAccount(uid, email, machine);
  send(res, 200, signPass(account, uid, machine));
});

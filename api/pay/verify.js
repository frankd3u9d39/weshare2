// POST /api/pay/verify  { idToken, reference, machine }
// Called by the app when Paystack's checkout finishes. Asks Paystack itself whether the payment
// went through, adds the week (once per payment) and returns a fresh access pass.
const { handler, readBody, send, HttpError, userFromIdToken, confirmPayment, creditPayment, getOrCreateAccount, signPass } = require('../_lib/core');

module.exports = handler(async (req, res) => {
  const { json } = await readBody(req);
  const { uid, email } = await userFromIdToken(json.idToken);
  const machine = typeof json.machine === 'string' ? json.machine.slice(0, 200) : '';

  const payment = await confirmPayment(json.reference);
  if (payment.uid && payment.uid !== uid) throw new HttpError(403, 'This payment belongs to another account.');
  if (!payment.ok) {
    return send(res, 200, { paid: false, status: payment.status });
  }
  await creditPayment(json.reference, uid, payment);
  const account = await getOrCreateAccount(uid, email, machine);
  send(res, 200, { paid: true, ...signPass(account, uid, machine) });
});

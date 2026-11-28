// POST /api/paystack-webhook
// Paystack calls this after every successful payment, so the week is added even if the
// customer closed Weshare before the payment finished. Set this URL in Paystack:
// Settings -> API Keys & Webhooks -> Webhook URL.
const crypto = require('crypto');
const { readBody, send, confirmPayment, creditPayment } = require('./_lib/core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const { raw, json } = await readBody(req);

    // Only Paystack can sign with our secret key.
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(raw).digest('hex');
    if (typeof signature !== 'string' || signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return send(res, 401, { error: 'Bad signature' });
    }

    if (json.event === 'charge.success' && json.data?.reference) {
      // Double-check with Paystack rather than trusting the message body.
      const payment = await confirmPayment(json.data.reference);
      if (payment.ok && payment.uid) await creditPayment(json.data.reference, payment.uid, payment);
    }
    send(res, 200, { received: true });
  } catch (e) {
    console.error('[webhook]', e);
    // Paystack retries on errors, which is what we want if saving failed.
    send(res, 500, { error: 'Failed' });
  }
};

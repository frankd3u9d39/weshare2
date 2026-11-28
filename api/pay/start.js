// POST /api/pay/start  { idToken }
// Starts a ₦1,000 Paystack payment for one week and returns Paystack's checkout page.
const crypto = require('crypto');
const { handler, readBody, send, userFromIdToken, paystack, PRICE_KOBO, CURRENCY } = require('../_lib/core');

module.exports = handler(async (req, res) => {
  const { json } = await readBody(req);
  const { uid, email } = await userFromIdToken(json.idToken);
  const site = process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const reference = `ws_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  const data = await paystack('/transaction/initialize', 'POST', {
    email,
    amount: PRICE_KOBO,
    currency: CURRENCY,
    reference,
    callback_url: `${site}/api/pay/done`,
    metadata: {
      uid,
      product: 'weshare-week',
      custom_fields: [{ display_name: 'Plan', variable_name: 'plan', value: 'Weshare · 7 days' }]
    }
  });

  send(res, 200, { reference, authorizationUrl: data.authorization_url });
});

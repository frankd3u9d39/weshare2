// GET /api/pay/done  — the page Paystack sends the customer back to after paying.
// Weshare closes its payment window as soon as it sees this address; this page is only
// seen if the payment was opened in a normal browser.
module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weshare · Payment</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121316;color:#f2f1ee;font-family:system-ui,'Segoe UI',sans-serif;text-align:center;padding:24px}
h1{font-size:22px;margin:0 0 8px}p{color:#a3a29d;margin:0;line-height:1.5}</style></head>
<body><div><h1>Thanks, payment received</h1><p>Go back to Weshare. Your week starts as soon as it shows "Active".</p></div></body></html>`);
};

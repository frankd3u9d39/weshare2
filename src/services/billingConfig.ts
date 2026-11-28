/*
 * Weekly access (₦1,000 for 7 days, paid through Paystack).
 *
 * BILLING_API_URL is the address of the Vercel site that has the /api payment functions,
 * e.g. 'https://weshare.vercel.app'. While it is empty, billing is switched off and
 * Weshare works without an account (handy while setting things up).
 *
 * LICENSE_PUBLIC_KEY checks the access passes the server signs. Its private half lives only
 * in Vercel (LICENSE_PRIVATE_KEY), so a pass can't be made or edited on a PC.
 */
export const BILLING_API_URL = process.env.WESHARE_BILLING_URL || '';

export const PRICE_LABEL = '₦1,000';
export const WEEK_DAYS = 7;
export const TRIAL_DAYS = 3;

export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASEYcpQHYp/K3tOzJD71zfotu8n/eht0fqzRHp6Q9Duc=
-----END PUBLIC KEY-----`;

export const isBillingEnabled = () => !!BILLING_API_URL;

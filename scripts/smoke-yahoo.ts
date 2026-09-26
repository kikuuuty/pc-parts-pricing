import { fetchYahoo } from '../src/providers/yahoo/transport';
import { validJan } from '../src/providers/yahoo/identifiers';
import { RefreshError } from '../src/providers/errors';

const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.error('Live access is disabled. Explicitly supply --live --code <verified-JAN-or-EAN13>.');
  process.exitCode = 1;
} else {
  const code = args[args.indexOf('--code') + 1];
  if (!args.includes('--code') || !validJan(code) || !process.env.YAHOO_SHOPPING_APP_ID?.trim()) {
    console.error('A valid code and YAHOO_SHOPPING_APP_ID environment Secret are required.');
    process.exitCode = 1;
  } else {
    try {
      const result = await fetchYahoo(process.env.YAHOO_SHOPPING_APP_ID, code, event => console.log(JSON.stringify(event)));
      console.log(JSON.stringify({ status: result.offer_count ? 'complete' : 'empty', offer_count: result.offer_count }));
    } catch (error) {
      console.error(JSON.stringify({ error: error instanceof RefreshError ? error.reason : 'unavailable' }));
      process.exitCode = 1;
    }
  }
}

import fs from 'node:fs';
let source=fs.readFileSync('worker/baseline.mjs','utf8').replaceAll('\r\n','\n');
function replaceOnce(before,after){if(!source.includes(before))throw Error('Baseline mismatch: '+before.slice(0,80));source=source.replace(before,after);}
replaceOnce('"/admin/pricing-report"\n    ];','"/admin/pricing-report",\n      "/admin/refresh-pricing"\n    ];');
const start=source.indexOf('      // Private illustrative pricing calculator.');
const end=source.indexOf('      if (!env.CJ_API_KEY)',start);
if(start<0||end<start)throw Error('Pricing route boundaries missing');
source=source.slice(0,start)+`      if (url.pathname === "/admin/pricing-report") {
        const after=Number(url.searchParams.get('after')??0);
        if(!Number.isSafeInteger(after)||after<0)return Response.json({error:'Invalid cursor'},{status:400,headers:noStore});
        return Response.json(await pricingReport(env,after),{headers:noStore});
      }
      if (url.pathname === "/admin/refresh-pricing") {
        return Response.json(await runPricing(env,getCJAccessToken),{headers:noStore});
      }

`+source.slice(end);
// Keep original importer and diagnostic routes; scheduled pricing is prioritized.
replaceOnce('      const result = await importCandidates(\n        env,\n        auth.accessToken\n      );\n\n      console.log(',`      const pricing = await runPricing(env, async () => auth);
      if (!['completed','fx_pending_verification'].includes(pricing.status)) {
        console.log('Scheduled catalogue import deferred after pricing refresh', {status:pricing.status});
        return;
      }
      const result = await importCandidates(env, auth.accessToken);

      console.log(`);
// Supplier auth timeout applies to existing flows, without changing credential storage.
replaceOnce('      method: "POST",\n      headers: {\n        "Content-Type": "application/json"','      method: "POST",\n      signal: AbortSignal.timeout(12000),\n      headers: {\n        "Content-Type": "application/json"');
replaceOnce('<h2>Illustrative pricing</h2>','<h2>Automatic provisional pricing</h2>\n<p id="engine" class="small"></p>');
replaceOnce('<th>Product</th><th>Test price</th>','<th>Product</th><th>Provisional price</th>');
replaceOnce('<button id="lock"','<button id="refresh" class="secondary" type="button">Refresh product research</button>\n<button id="lock"');
replaceOnce('Product research and provisional pricing · Read-only development mode','Private product research · All products held for review');
const scriptStart=source.indexOf('<script>'),scriptEnd=source.indexOf('</script>',scriptStart);
const dashboard=fs.readFileSync('worker/dashboard.js','utf8');
if(dashboard.includes('`')||dashboard.includes('${'))throw Error('Dashboard must be template-literal safe');
source=source.slice(0,scriptStart)+'<script>\n'+dashboard+'</script>'+source.slice(scriptEnd+9);
// Baseline screen flags remain conservative and unchanged. Pricing table paginates separately.
const engine=fs.readFileSync('worker/pricing-engine.mjs','utf8').replace(/^export /gm,'');
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/worker.mjs',engine+'\n'+source);
console.log('Built dist/worker.mjs from inspected deployed baseline.');

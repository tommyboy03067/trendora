import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {POLICY,decimal,validFx,calculatePrice,chooseVariant,chooseOrigin,chooseShipping,
  supplierClient,migratePricing,runPricing,pricingReport,priceRow} from '../worker/pricing-engine.mjs';
import worker from '../dist/worker.mjs';
import baseline from '../worker/baseline.mjs';
const NOW=Date.parse('2026-09-27T12:00:00Z');
const fx={date:'2026-09-25',base:'USD',quote:'GBP',rate:0.76};
const candidate={id:1,supplier:'CJdropshipping',supplier_product_id:'1363726889776189440',supplier_variant_id:'1363726891126755328',product_name:'Cardigan',review_status:'pending'};
const variant={vid:candidate.supplier_variant_id,pid:candidate.supplier_product_id,variantNameEn:'Red 80cm',variantSellPrice:'5.37'};
const details={pid:candidate.supplier_product_id,variants:[variant]};
const inventory=[{vid:variant.vid,countryCode:'CN',cjInventoryNum:10,factoryInventoryNum:200}];
const shipping=[{logisticName:'Tracked test method',logisticPrice:6.27,logisticAging:'4-7'}];
function database(count=1){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE product_candidates(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier TEXT NOT NULL,
    supplier_product_id TEXT NOT NULL,supplier_variant_id TEXT,product_name TEXT NOT NULL,product_image TEXT,
    supplier_price_usd REAL,shipping_cost_usd REAL,estimated_delivery_days TEXT,stock_status TEXT DEFAULT 'unverified',
    review_status TEXT DEFAULT 'pending',screening_status TEXT DEFAULT 'not_checked',screening_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier,supplier_product_id,supplier_variant_id));
    CREATE UNIQUE INDEX product_level_unique ON product_candidates(supplier,supplier_product_id) WHERE supplier_variant_id IS NULL;
    CREATE TABLE supplier_token_cache(supplier TEXT PRIMARY KEY,access_token TEXT,expires_at INTEGER,updated_at TEXT);`);
  for(let i=1;i<=count;i++)sqlite.prepare('INSERT INTO product_candidates(id,supplier,supplier_product_id,supplier_variant_id,product_name) VALUES(?,?,?,?,?)')
    .run(i,'CJdropshipping',i===1?candidate.supplier_product_id:'p'+i,i===1?variant.vid:null,i===1?'Cardigan':'Ear clip '+i);
  const db={sqlite,prepare(sql){let params=[];const statement={bind(...p){params=p;return statement;},
    async first(){return sqlite.prepare(sql).get(...params)??null;},async all(){return {results:sqlite.prepare(sql).all(...params)};},
    syncRun(){const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes)}};},
    async run(){return statement.syncRun();}};return statement;},
    async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.syncRun());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return db;
}
function envelope(data,more={}){return Response.json({code:200,result:true,data,...more});}
function mockSupplier(overrides={}){return async (url,init)=>{
  const u=new URL(url);if(u.host==='api.frankfurter.dev')return Response.json([fx]);
  const endpoint=u.pathname.replace('/api2.0/v1','');
  if(overrides[endpoint])return overrides[endpoint](u,init);
  if(endpoint==='/product/query'){const pid=u.searchParams.get('pid');return envelope(pid===candidate.supplier_product_id?details:{pid,variants:[{vid:pid+'-v',variantSellPrice:7,variantNameEn:pid}]});}
  if(endpoint==='/product/stock/queryByVid')return envelope([{...inventory[0],vid:u.searchParams.get('vid')}]);
  if(endpoint==='/logistic/freightCalculate'){const body=JSON.parse(init.body);assert.equal(body.endCountryCode,'GB');assert.equal(body.products[0].quantity,1);return envelope(shipping);}
  throw Error('Unexpected outbound request '+url);
};}
const envFor=db=>({TRENDORA_DB:db,CJ_API_KEY:'fixture-key',TRENDORA_ADMIN_TOKEN:'fixture-admin'});
const options={now:()=>NOW,sleep:async()=>{},fetchFn:mockSupplier()};
const auth=async()=>({accessToken:'fixture-token'});
test('rejects missing, malformed, ranged, negative and nonnumeric prices',()=>{
  for(const v of [null,undefined,'',' ','1-3',false,{},NaN,Infinity,-1,'0x10','1e3'])assert.equal(decimal(v),null);
  assert.equal(decimal(' 5.37 '),5.37);
  assert.equal(calculatePrice(null,6.27,fx,NOW),null);
  assert.equal(calculatePrice(5.37,null,fx,NOW),null);
  assert.equal(calculatePrice(0,6.27,fx,NOW),null);
});
test('FX must match currency, not be stale or future dated',()=>{
  assert.ok(validFx(fx,NOW));for(const f of [{...fx,date:'2026-09-28'},{...fx,date:'2026-09-01'},{...fx,base:'EUR'},{...fx,rate:0},{...fx,date:'bad'}])assert.equal(validFx(f,NOW),false);
});
test('prices satisfy £5 floor and 40% margin after conservative rounding across costs',()=>{
  for(let p=0.01;p<200;p+=0.31){const r=calculatePrice(p,6.27,fx,NOW);assert.ok(r.estimatedContributionGbp>=5);assert.ok(r.estimatedGrossMarginPercent>=40);assert.equal(Math.round(r.provisionalPriceGbp*100)%100,99);}
  const r=calculatePrice(5.37,6.27,fx,NOW);assert.equal(r.provisionalPriceGbp,15.99);assert.ok(r.estimatedContributionGbp>=5);
});
test('preserves saved variant and deterministically documents a representative',()=>{
  assert.equal(chooseVariant(candidate,details).variant.vid,variant.vid);
  assert.throws(()=>chooseVariant(candidate,{...details,variants:[]}),/existing_variant/);
  const r=chooseVariant({...candidate,supplier_variant_id:null},{...details,variants:[{vid:'b',variantSellPrice:3},{vid:'a',variantSellPrice:3},{vid:'z',variantSellPrice:4}]});
  assert.equal(r.variant.vid,'a');assert.match(r.rule,/Representative/);
  assert.throws(()=>chooseVariant(candidate,{...details,pid:'wrong'}),/identity/);
});
test('stock requires matching ID and positive CJ stock, not factory inventory',()=>{
  assert.equal(chooseOrigin(inventory,variant.vid).country,'CN');
  assert.throws(()=>chooseOrigin([{...inventory[0],cjInventoryNum:0}],variant.vid),/warehouse_stock/);
  assert.throws(()=>chooseOrigin(inventory,'other'),/warehouse_stock/);
  assert.equal(chooseOrigin([...inventory,{...inventory[0],countryCode:'GB'}],variant.vid).country,'GB');
});
test('freight includes quoted charges, rejects implausible totals and unverified transit',()=>{
  assert.equal(chooseShipping(shipping).costUsd,6.27);
  assert.ok(chooseShipping(shipping).taxesUnverified);
  assert.equal(chooseShipping([{...shipping[0],taxesFee:1,clearanceOperationFee:2,totalPostageFee:9.27}]).costUsd,9.27);
  assert.throws(()=>chooseShipping([{...shipping[0],taxesFee:2,totalPostageFee:6.27}]),/no_suitable/);
  for(const logisticAging of ['unknown','4-90','0-1','7-4','4-7 working days'])assert.throws(()=>chooseShipping([{...shipping[0],logisticAging}]),/no_suitable/);
});
test('supplier client allow-list, quota points, malformed data and rate-limit backoff',async()=>{
  const c=supplierClient('secret',{sleep:async()=>{},fetchFn:async()=>envelope(details,{pointsInfo:{remaining:0}})});
  await assert.rejects(c.call('/shopping/order/createOrder'),/not_allowed/);
  await c.call('/product/query');await assert.rejects(c.call('/product/query'),/quota_deferred/);
  const limited=supplierClient('secret',{fetchFn:async()=>Response.json({code:429},{status:429})});
  await assert.rejects(limited.call('/product/query'),e=>e.stop&&e.retryMs>=600000);
  const malformed=supplierClient('secret',{fetchFn:async()=>new Response('<html>')});
  await assert.rejects(malformed.call('/product/query'),/network_or_format/);
});
test('migration is repeatable and never modifies legacy tables or candidate decisions',async()=>{
  const db=database();const before=JSON.stringify(db.sqlite.prepare('SELECT * FROM product_candidates').all());
  await migratePricing(db);await migratePricing(db);
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM product_candidates').all()),before);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM pricing_control_v1').get().n,1);
});
test('report before migration is read-only and all candidates are pending',async()=>{
  const db=database(10),report=await pricingReport(envFor(db),0,NOW);
  assert.equal(report.candidates.length,10);assert.ok(report.candidates.every(p=>p.provisionalPriceGbp===null));
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'pricing_%'").get().n,0);
});
test('full batch researches all ten, preserves original records, records evidence and rate',async()=>{
  const db=database(10),env=envFor(db),before=JSON.stringify(db.sqlite.prepare('SELECT * FROM product_candidates').all());
  const r=await runPricing(env,auth,options);assert.equal(r.checked,10);assert.equal(r.priced,10);assert.equal(r.supplierCalls,30);
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM product_candidates').all()),before);
  const report=await pricingReport(env,0,NOW);assert.equal(report.candidates.length,10);assert.ok(report.candidates.every(p=>p.provisionalPriceGbp>0&&p.holdForManualReview));
  assert.equal(report.publicationEnabled,false);assert.equal(report.supplierPurchasesEnabled,false);
  assert.equal((await runPricing(env,auth,options)).status,'busy_or_cooling_down');
});
test('failure retains good evidence but removes current price; next candidate gets a turn',async()=>{
  const db=database(2),env=envFor(db);await runPricing(env,auth,options);
  const saved=db.sqlite.prepare('SELECT last_good_json FROM pricing_snapshots_v1 WHERE candidate_id=1').get().last_good_json;
  const failed=await runPricing(env,auth,{...options,now:()=>NOW+120000,fetchFn:mockSupplier({'/product/query':async()=>Response.json({code:429},{status:429})})});
  assert.equal(failed.checked,1);assert.equal(failed.status,'supplier_rate_limited');
  const report=await pricingReport(env,0,NOW+120000);assert.equal(report.candidates[0].provisionalPriceGbp,null);
  assert.equal(db.sqlite.prepare('SELECT last_good_json FROM pricing_snapshots_v1 WHERE candidate_id=1').get().last_good_json,saved);
  assert.equal(db.sqlite.prepare('SELECT candidate_id FROM pricing_snapshots_v1 ORDER BY attempted_at,candidate_id LIMIT 1').get().candidate_id,2);
});
test('concurrent runs cannot both obtain the lease',async()=>{
  const db=database(),env=envFor(db);const results=await Promise.all([runPricing(env,auth,options),runPricing(env,auth,options)]);
  assert.equal(results.filter(r=>r.status==='busy_or_cooling_down').length,1);
  assert.equal(results.filter(r=>r.checked===1).length,1);
});
test('stale quotes and changed variant identities cannot produce prices',async()=>{
  const db=database();await runPricing(envFor(db),auth,options);
  const row=db.sqlite.prepare('SELECT c.*,p.status,p.snapshot_json FROM product_candidates c JOIN pricing_snapshots_v1 p ON p.candidate_id=c.id').get();
  assert.equal(priceRow(row,fx,NOW+25*3600000).provisionalPriceGbp,null);
  assert.equal(priceRow({...row,supplier_variant_id:'changed'},fx,NOW).provisionalPriceGbp,null);
});
test('pagination includes every candidate beyond the legacy limit of 50',async()=>{
  const db=database(205),env=envFor(db);let all=[],after=0;
  do{const r=await pricingReport(env,after,NOW);all.push(...r.candidates);after=r.nextCursor;}while(after!==null);
  assert.equal(all.length,205);assert.equal(new Set(all.map(p=>p.id)).size,205);
});
test('unauthenticated and wrong-method requests never reach database or supplier',async()=>{
  const env={TRENDORA_ADMIN_TOKEN:'secret',TRENDORA_DB:{prepare(){throw Error('must not query');}}};
  for(const path of ['/admin/pricing-report','/admin/refresh-pricing','/admin/candidates','/admin/import-candidates','/admin/test-cj','/admin/screening-report']){
    assert.equal((await worker.fetch(new Request('https://test'+path,{method:'POST'}),env)).status,401);
    assert.equal((await worker.fetch(new Request('https://test'+path),env)).status,405);
  }
});
test('health, diagnostics and screening preserve baseline outputs including ear-clip regression',async()=>{
  const env=envFor(database(2));
  for(const path of ['/health','/admin/test-db','/admin/candidates','/admin/screening-report']){
    const request=()=>new Request('https://test'+path,{method:path==='/health'?'GET':'POST',headers:{'X-Admin-Token':'fixture-admin'}});
    assert.deepEqual(await (await worker.fetch(request(),env)).json(),await (await baseline.fetch(request(),env)).json());
  }
  const report=await (await worker.fetch(new Request('https://test/admin/screening-report',{method:'POST',headers:{'X-Admin-Token':'fixture-admin'}}),env)).json();
  assert.ok(!report.candidates.find(p=>p.id===2).flags.some(f=>f.startsWith('Cosmetics')));
});
test('dashboard retains security headers, uses text rendering and has no persistent credentials',async()=>{
  const response=await worker.fetch(new Request('https://test/dashboard'),{}),html=await response.text();
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  assert.match(html,/Refresh product research/);assert.match(html,/Price pending verification/);
  assert.ok(!/localStorage\.|sessionStorage\.|document\.cookie\s*=|\.innerHTML\s*=/.test(html));
  assert.match(html,/current!==generation/);
  // Compile the emitted browser script, not only its source module.
  new Function(html.split('<script>')[1].split('</script>')[0]);
});

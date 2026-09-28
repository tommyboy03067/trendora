// Private research only. No ordering, payments, approvals or publishing APIs.
export const POLICY = Object.freeze({
  version: 1, paymentFeePercent: 1.5, paymentFeeFixedGbp: 0.20,
  minimumContributionGbp: 5, targetGrossMarginPercent: 40,
  fxBufferPercent: 2, maxTransitDays: 15, maxCandidatesPerRun: 10,
  supplierMaxAgeMs: 24 * 3600000, fxMaxAgeMs: 7 * 86400000,
  note: 'Fees and 2% FX buffer are assumptions, not verified charges. Contribution excludes advertising, returns, VAT/taxes not quoted by CJ and overhead. Transit excludes unverified processing time. All products remain on hold.'
});
const SUPPLIER_API = 'https://developers.cjdropshipping.com/api2.0/v1';
export const FX_URL = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=GBP';
const SAFETY = { automaticallyApproved: 0, publicationEnabled: false, supplierPurchasesEnabled: false };
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pricing_snapshots_v1 (
    candidate_id INTEGER PRIMARY KEY REFERENCES product_candidates(id),
    attempted_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
    snapshot_json TEXT, last_good_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pricing_attempted_v1 ON pricing_snapshots_v1(attempted_at)`,
  `CREATE TABLE IF NOT EXISTS pricing_control_v1 (
    id INTEGER PRIMARY KEY CHECK(id=1), lock_owner TEXT,
    lock_until INTEGER NOT NULL DEFAULT 0, next_allowed INTEGER NOT NULL DEFAULT 0,
    last_finished INTEGER, last_status TEXT, summary_json TEXT, fx_json TEXT
  )`,
  `INSERT OR IGNORE INTO pricing_control_v1(id) VALUES(1)`
];
export async function migratePricing(db) {
  // Additive and atomic: original catalogue and token tables are never altered.
  await db.batch(MIGRATIONS.map(sql => db.prepare(sql)));
}
export function decimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1000000 ? n : null;
}
function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
export function validFx(fx, now = Date.now()) {
  const date = typeof fx?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fx.date)
    ? Date.parse(fx.date+'T00:00:00Z') : NaN;
  return fx?.base === 'USD' && fx?.quote === 'GBP' && decimal(fx.rate) > 0 &&
    fx.rate < 10 && Number.isFinite(date) && date <= now && now-date <= POLICY.fxMaxAgeMs;
}
export function calculatePrice(supplierUsd, shippingUsd, fx, now = Date.now()) {
  const cost = decimal(supplierUsd), shipping = decimal(shippingUsd);
  if (!(cost > 0) || shipping === null || !validFx(fx, now)) return null;
  // Round costs and fees UP to pence, then choose the next .99 that meets BOTH constraints.
  const costPence = Math.ceil((cost+shipping)*fx.rate*(1+POLICY.fxBufferPercent/100)*100-1e-9);
  const feeRate = POLICY.paymentFeePercent/100, fixed = Math.ceil(POLICY.paymentFeeFixedGbp*100);
  const floor = Math.max((costPence+fixed+500)/(1-feeRate), costPence/0.6);
  let price = Math.ceil((floor-99)/100)*100+99;
  let fee = Math.ceil(price*feeRate-1e-9)+fixed;
  while (price-costPence-fee<500 || (price-costPence)/price<0.4) {
    price+=100;fee=Math.ceil(price*feeRate-1e-9)+fixed;
  }
  return { provisionalPriceGbp: price/100, testPriceGbp: price/100,
    estimatedSupplierAndShippingGbp: costPence/100, estimatedPaymentFeeGbp: fee/100,
    estimatedContributionGbp: (price-costPence-fee)/100,
    estimatedGrossMarginPercent: Math.round((price-costPence)/price*10000)/100,
    meetsIllustrativeFivePoundThreshold: true };
}
export function chooseVariant(candidate, details) {
  if (identifier(details?.pid) !== String(candidate.supplier_product_id))
    throw new Error('product_identity_mismatch');
  if (!Array.isArray(details.variants)) throw new Error('variant_details_unavailable');
  const variants = details.variants.filter(v => identifier(v.vid) &&
    (!v.pid || identifier(v.pid) === String(candidate.supplier_product_id)));
  const existing = candidate.supplier_variant_id;
  if (existing) {
    const variant = variants.find(v => identifier(v.vid) === String(existing));
    if (!variant) throw new Error('existing_variant_not_available');
    return {variant, totalVariants: variants.length, rule:'Existing saved variant retained; no substitution.'};
  }
  const priced = variants.filter(v => decimal(v.variantSellPrice)>0)
    .sort((a,b) => Number(a.variantSellPrice)-Number(b.variantSellPrice) || String(a.vid).localeCompare(String(b.vid)));
  if (!priced.length) throw new Error('no_valid_variant_price');
  return {variant:priced[0], totalVariants:variants.length,
    rule:'Representative variant: lowest positive CJ variant price; ties by variant ID. Stock and UK freight checked for this variant only. Not a price for every size/colour or a guarantee of the cheapest landed option.'};
}
export function chooseOrigin(rows, vid) {
  if (!Array.isArray(rows)) throw new Error('stock_format_unavailable');
  const locations = rows.filter(r => identifier(r.vid) === String(vid) &&
    typeof r.countryCode === 'string' && /^[A-Z]{2}$/.test(r.countryCode) &&
    decimal(r.cjInventoryNum)>0 && Number.isInteger(Number(r.cjInventoryNum)));
  // Factory inventory is not treated as ready-to-ship CJ warehouse stock.
  const priority = c => c === 'GB' ? 0 : c === 'CN' ? 1 : 2;
  locations.sort((a,b) => priority(a.countryCode)-priority(b.countryCode) || a.countryCode.localeCompare(b.countryCode));
  if (!locations.length) throw new Error('no_reported_cj_warehouse_stock');
  const selected = locations[0];
  return { country: selected.countryCode, cjInventory: Number(selected.cjInventoryNum),
    factoryInventory: decimal(selected.factoryInventoryNum),
    rule:'Positive CJ-managed stock required; prefer GB, then CN, then country code. Factory-only stock is held for verification.' };
}
export function transitDays(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/);
  if (!match) return null;
  const min=Number(match[1]),max=Number(match[2]??match[1]);
  return min>0 && max>=min && max<=POLICY.maxTransitDays ? {min,max} : null;
}
export function chooseShipping(rows) {
  if (!Array.isArray(rows)) throw new Error('shipping_format_unavailable');
  const options = rows.map(row => {
    const freight=decimal(row.logisticPrice), total=decimal(row.totalPostageFee);
    const tax=decimal(row.taxesFee), clearance=decimal(row.clearanceOperationFee);
    const transit=transitDays(row.logisticAging);
    if(freight===null || !transit || typeof row.logisticName!=='string' || !row.logisticName.trim()) return null;
    if ((row.taxesFee!=null && tax===null) || (row.clearanceOperationFee!=null && clearance===null) ||
        (row.totalPostageFee!=null && total===null)) return null;
    // Do not add components to a supplied total (double counting); reject inconsistent totals.
    const components=freight+(tax??0)+(clearance??0);
    if(total!==null && total+0.005<components) return null;
    return { method:row.logisticName, costUsd:total??components, freightUsd:freight,
      quotedTaxUsd:tax, quotedClearanceUsd:clearance, totalPostageUsd:total, transit,
      taxesUnverified:tax===null || clearance===null,
      rule:'Lowest available quoted total for one unit to GB, with numeric transit at most 15 days; ties by fastest maximum transit then method name. Tracking and end-to-end delivery remain unverified.' };
  }).filter(Boolean).sort((a,b) => a.costUsd-b.costUsd || a.transit.max-b.transit.max || a.method.localeCompare(b.method));
  if(!options.length) throw new Error('no_suitable_uk_shipping_quote');
  return {...options[0], suitableOptions:options.length};
}
class ResearchError extends Error {
  constructor(code, stop=false, retryMs=600000){super(code);this.stop=stop;this.retryMs=retryMs;}
}
export function supplierClient(token, {fetchFn=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms)), now=()=>Date.now()}={}) {
  let calls=0,last=0,remaining=Infinity;
  return {get calls(){return calls;},async call(path, params, body) {
    // Hard allow-list prevents accidental use for supplier purchases or publication.
    if(!['/product/query','/product/stock/queryByVid','/logistic/freightCalculate'].includes(path))
      throw new ResearchError('supplier_endpoint_not_allowed',true);
    if(calls>=32 || remaining<10) throw new ResearchError('supplier_quota_deferred',true);
    if(last) await sleep(Math.max(0,1100-(now()-last)));
    calls++;last=now();
    const url=new URL(SUPPLIER_API+path);
    for(const [key,value] of Object.entries(params??{})) url.searchParams.set(key,String(value));
    let response,data;
    try {
      response=await fetchFn(url.toString(),{method:body?'POST':'GET',
        headers:{'CJ-Access-Token':token,...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
      data=await response.json();
    } catch {throw new ResearchError('supplier_network_or_format_error',true);}
    const code=Number(data.code);
    if([401,403].includes(response.status) || [401,403].includes(code))
      throw new ResearchError('supplier_authentication_or_access_denied',true);
    if([402,406,429].includes(response.status) || [402,406,429].includes(code)) {
      const seconds=Number(response.headers.get('Retry-After'));
      throw new ResearchError('supplier_rate_limited',true,Math.max(600000,Number.isFinite(seconds)?seconds*1000:0));
    }
    if(response.status>=500) throw new ResearchError('supplier_temporarily_unavailable',true);
    if(!response.ok || code!==200 || data.result!==true)
      throw new ResearchError('supplier_rejected_request');
    const points=decimal(data.pointsInfo?.remaining);
    if(points!==null) remaining=points;
    return {data:data.data,requestId:typeof data.requestId==='string'?data.requestId:null};
  }};
}
export async function researchCandidate(candidate, client, now=Date.now()) {
  if(candidate.supplier!=='CJdropshipping') throw new Error('unsupported_supplier');
  const product=await client.call('/product/query',{pid:candidate.supplier_product_id});
  const selected=chooseVariant(candidate,product.data),v=selected.variant;
  const price=decimal(v.variantSellPrice);
  if(!(price>0)) throw new Error('supplier_variant_price_unavailable');
  const stock=await client.call('/product/stock/queryByVid',{vid:v.vid});
  const origin=chooseOrigin(stock.data,v.vid);
  const freight=await client.call('/logistic/freightCalculate',null,{
    startCountryCode:origin.country,endCountryCode:'GB',products:[{quantity:1,vid:String(v.vid)}]
  });
  const shipping=chooseShipping(freight.data);
  return {version:POLICY.version, checkedAt:now, productId:String(candidate.supplier_product_id),
    variantId:String(v.vid),variantName:String(v.variantNameEn??v.variantKey??v.vid),
    variantCount:selected.totalVariants,variantRule:selected.rule,supplierPriceUsd:price,
    origin,shipping,processingDays:null,fullDeliveryDays:null,stockStatus:'supplier_reported_not_reserved',
    sources:{product:product.requestId,stock:stock.requestId,freight:freight.requestId}};
}
function readJson(s){try{return JSON.parse(s??'null');}catch{return null;}}
async function loadFx(db, fetchFn, now) {
  try {
    const response=await fetchFn(FX_URL+'&date='+new Date(now).toISOString().slice(0,10),{signal:AbortSignal.timeout(8000)});
    const data=await response.json();
    const fx=Array.isArray(data)?data.find(r=>r.base==='USD'&&r.quote==='GBP'):null;
    if(!response.ok||!validFx(fx,now)) throw new Error('invalid_fx');
    const result={...fx,source:'Frankfurter reference rate',retrievedAt:now,cached:false};
    await db.prepare('UPDATE pricing_control_v1 SET fx_json=? WHERE id=1').bind(JSON.stringify(result)).run();
    return result;
  } catch {
    const row=await db.prepare('SELECT fx_json FROM pricing_control_v1 WHERE id=1').first();
    const cached=readJson(row?.fx_json);
    return validFx(cached,now)?{...cached,cached:true}:null;
  }
}
export async function runPricing(env, getToken, options={}) {
  const db=env.TRENDORA_DB,now=options.now??(()=>Date.now()),fetchFn=options.fetchFn??fetch;
  if(!db||!env.CJ_API_KEY) return {status:'required_binding_missing',...SAFETY};
  await migratePricing(db);
  const start=now(),owner=crypto.randomUUID();
  const lock=await db.prepare(`UPDATE pricing_control_v1 SET lock_owner=?,lock_until=?,last_status='running'
    WHERE id=1 AND lock_until<=? AND next_allowed<=?`).bind(owner,start+600000,start,start).run();
  if(!lock.meta?.changes) return {status:'busy_or_cooling_down',...SAFETY};
  const summary={status:'completed',checked:0,priced:0,pending:0,supplierCalls:0,...SAFETY};
  let cooldown=60000;
  try {
    const fx=await loadFx(db,fetchFn,now());
    const auth=await getToken(env);
    if(!auth?.accessToken) throw new ResearchError('supplier_authentication_failed',true);
    const client=supplierClient(auth.accessToken,{fetchFn,sleep:options.sleep,now});
    // Oldest attempted first gives every candidate a turn, including failures; never starve later IDs.
    const rows=await db.prepare(`SELECT c.* FROM product_candidates c
      LEFT JOIN pricing_snapshots_v1 p ON p.candidate_id=c.id
      ORDER BY COALESCE(p.attempted_at,0),c.id LIMIT ?`).bind(POLICY.maxCandidatesPerRun).all();
    for(const candidate of rows.results) {
      if(now()-start>480000){summary.status='time_budget_deferred';break;}
      const attempt=now();
      try {
        const snapshot=await researchCandidate(candidate,client,now());
        const json=JSON.stringify(snapshot);
        await db.prepare(`INSERT INTO pricing_snapshots_v1(candidate_id,attempted_at,status,reason,snapshot_json,last_good_json)
          VALUES(?,?,'researched',NULL,?,?) ON CONFLICT(candidate_id) DO UPDATE SET
          attempted_at=excluded.attempted_at,status=excluded.status,reason=NULL,
          snapshot_json=excluded.snapshot_json,last_good_json=excluded.last_good_json`)
          .bind(candidate.id,attempt,json,json).run();
        summary.checked++;
        if(calculatePrice(snapshot.supplierPriceUsd,snapshot.shipping.costUsd,fx,now())) summary.priced++;
        else summary.pending++;
      } catch(error) {
        const reason=error instanceof ResearchError || /^(product_|variant_|existing_|no_|stock_|shipping_|supplier_variant_|unsupported_)/.test(error.message)
          ? error.message:'research_failed';
        console.warn('Trendora candidate research pending',{candidateId:candidate.id,reason});
        // Do not overwrite last good evidence; do not present it as fresh after a failed attempt.
        await db.prepare(`INSERT INTO pricing_snapshots_v1(candidate_id,attempted_at,status,reason)
          VALUES(?,?,'pending',?) ON CONFLICT(candidate_id) DO UPDATE SET
          attempted_at=excluded.attempted_at,status='pending',reason=excluded.reason`)
          .bind(candidate.id,attempt,reason).run();
        summary.checked++;summary.pending++;
        if(error.stop){summary.status=reason;cooldown=error.retryMs??600000;break;}
      }
    }
    summary.supplierCalls=client.calls;
    if(!fx && summary.status==='completed')summary.status='fx_pending_verification';
  } catch(error) {
    summary.status=error instanceof ResearchError?error.message:'pricing_refresh_failed';cooldown=600000;
  } finally {
    await db.prepare(`UPDATE pricing_control_v1 SET lock_owner=NULL,lock_until=0,next_allowed=?,
      last_finished=?,last_status=?,summary_json=? WHERE id=1 AND lock_owner=?`)
      .bind(now()+cooldown,now(),summary.status,JSON.stringify(summary),owner).run();
  }
  console.log('Trendora private pricing refresh',summary);
  return summary;
}
export function priceRow(row, fx, now=Date.now()) {
  const snapshot=readJson(row.snapshot_json);
  let reason=row.reason??'awaiting_first_refresh';
  const identity=snapshot?.productId===String(row.supplier_product_id) &&
    (!row.supplier_variant_id||snapshot.variantId===String(row.supplier_variant_id));
  const fresh=identity && snapshot.version===POLICY.version && Number.isFinite(snapshot.checkedAt) &&
    now>=snapshot.checkedAt && now-snapshot.checkedAt<=POLICY.supplierMaxAgeMs;
  let calculation=null;
  if(row.status==='researched') {
    if(!identity)reason='candidate_variant_changed';
    else if(!fresh)reason='supplier_data_stale';
    else if(!validFx(fx,now))reason='exchange_rate_pending_verification';
    else {
      calculation=calculatePrice(snapshot.supplierPriceUsd,snapshot.shipping.costUsd,fx,now);
      reason=calculation?'Provisional research estimate; hold for manual review.':'costs_pending_verification';
    }
  }
  return {id:row.id,productName:row.product_name,reviewStatus:row.review_status,
    provisionalPriceGbp:null,testPriceGbp:null,estimatedContributionGbp:null,estimatedGrossMarginPercent:null,
    ...calculation,status:calculation?'Provisional · on hold':'Price pending verification',reason,
    checkedAt:snapshot?.checkedAt??null,attemptedAt:row.attempted_at??null,
    evidence:snapshot??null,evidenceCurrent:row.status==='researched'&&fresh,
    holdForManualReview:true};
}
export async function pricingReport(env, after=0, now=Date.now()) {
  const db=env.TRENDORA_DB;
  if(!db)throw new Error('Database connection unavailable.');
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pricing_snapshots_v1'").first();
  const control=exists?await db.prepare('SELECT * FROM pricing_control_v1 WHERE id=1').first():null;
  const rows=await db.prepare(exists?`SELECT c.*,p.attempted_at,p.status,p.reason,p.snapshot_json
    FROM product_candidates c LEFT JOIN pricing_snapshots_v1 p ON p.candidate_id=c.id WHERE c.id>? ORDER BY c.id LIMIT 101`
    :'SELECT * FROM product_candidates WHERE id>? ORDER BY id LIMIT 101').bind(after).all();
  const count=await db.prepare('SELECT COUNT(*) AS total FROM product_candidates').first();
  const fx=readJson(control?.fx_json),page=rows.results.slice(0,100);
  return {engineVersion:POLICY.version,...SAFETY,candidateCount:count.total,
    assumptions:{...POLICY,usdToGbp:validFx(fx,now)?fx.rate:null},fx:validFx(fx,now)?fx:null,
    engine:{status:control?.last_status??'awaiting_first_refresh',lastFinished:control?.last_finished??null,
      busy:(control?.lock_until??0)>now,nextAllowed:control?.next_allowed??0,
      summary:readJson(control?.summary_json)},
    candidates:page.map(row=>priceRow(row,fx,now)),
    nextCursor:rows.results.length>100?page.at(-1).id:null};
}

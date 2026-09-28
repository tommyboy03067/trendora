(function () {
  'use strict';
  const byId=id=>document.getElementById(id);
  let generation=0,controller=null;
  const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=value==null?'—':String(value);return el;};
  const money=n=>typeof n==='number'&&Number.isFinite(n)?'£'+n.toFixed(2):'—';
  const date=n=>typeof n==='number'?new Date(n).toLocaleString('en-GB'):'Never';
  function clearTable(id,message){const row=document.createElement('tr'),cell=text('td',message);cell.colSpan=id==='products'?4:5;row.append(cell);byId(id).replaceChildren(row);}
  function clearReports(){['approved','publishing','purchasing','count'].forEach(id=>byId(id).textContent='—');clearTable('products','Dashboard locked.');clearTable('pricing','Dashboard locked.');byId('assumptions').textContent='';byId('engine').textContent='';}
  function lock(){generation++;controller?.abort();controller=null;byId('token').value='';clearReports();byId('message').textContent='Dashboard locked.';byId('message').className='';byId('load').disabled=false;byId('refresh').disabled=false;}
  async function report(path,token){
    const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'X-Admin-Token':token},signal:controller.signal});
    if(!r.ok)throw new Error(r.status===401?'Incorrect admin token.':'Request failed (HTTP '+r.status+').');
    return r.json();
  }
  function safety(data){if(data.automaticallyApproved!==0||data.publicationEnabled!==false||data.supplierPurchasesEnabled!==false)throw new Error('Safety setting mismatch. Reports not displayed.');}
  function screening(data){
    safety(data);byId('approved').textContent='0';byId('publishing').textContent='NO';byId('purchasing').textContent='NO';byId('count').textContent=data.candidateCount;
    const body=byId('products');body.replaceChildren();
    for(const product of data.candidates||[]){const row=document.createElement('tr');[product.id,product.productName,product.screeningOutcome].forEach(v=>row.append(text('td',v)));const cell=document.createElement('td'),list=document.createElement('ul');for(const flag of product.flags||[])list.append(text('li',flag));cell.append(list);row.append(cell);body.append(row);}
    if(!data.candidates?.length)clearTable('products','No candidates found.');
  }
  function pricing(data){
    safety(data);byId('count').textContent=data.candidateCount;const body=byId('pricing');body.replaceChildren();
    for(const p of data.candidates||[]){
      const row=document.createElement('tr');row.append(text('td',p.productName));row.append(text('td',p.provisionalPriceGbp==null?'Price pending verification':money(p.provisionalPriceGbp)));row.append(text('td',money(p.estimatedContributionGbp)));row.append(text('td',typeof p.estimatedGrossMarginPercent==='number'?p.estimatedGrossMarginPercent.toFixed(2)+'%':'—'));
      const cell=document.createElement('td');cell.append(text('strong',p.status));cell.append(text('p',p.reason.replaceAll('_',' ')));
      const e=p.evidence;
      if(e){const details=document.createElement('details');details.append(text('summary',(p.evidenceCurrent?'Supplier evidence':'Previous evidence — not current')+' · '+date(e.checkedAt)));
        const lines=[
          'Variant: '+e.variantName+' ('+e.variantId+'). '+e.variantRule,
          'CJ unit price: $'+e.supplierPriceUsd.toFixed(2)+' USD.',
          'Origin: '+e.origin.country+'; CJ-reported warehouse stock: '+e.origin.cjInventory+'. Stock is not reserved. '+e.origin.rule,
          'UK freight estimate: $'+e.shipping.costUsd.toFixed(2)+' USD via '+e.shipping.method+'. '+e.shipping.rule,
          'Transit: '+e.shipping.transit.min+'–'+e.shipping.transit.max+' days. Processing and full delivery time unverified.',
          'Supplier tax/clearance fields: '+(e.shipping.taxesUnverified?'incomplete; additional charges may apply.':'included as quoted; overall tax treatment unverified.')
        ];lines.forEach(line=>details.append(text('p',line)));cell.append(details);}
      row.append(cell);body.append(row);
    }
    if(!data.candidates?.length)clearTable('pricing','No candidates found.');
    const a=data.assumptions,f=data.fx;
    byId('assumptions').textContent=(f?'Reference FX: $1 = £'+f.rate+' dated '+f.date+' ('+f.source+'). ':'Current reference FX unavailable. ')+
      'Assumed payment fee '+a.paymentFeePercent+'% + '+money(a.paymentFeeFixedGbp)+'; FX buffer '+a.fxBufferPercent+'%; minimum contribution '+money(a.minimumContributionGbp)+'; target gross margin '+a.targetGrossMarginPercent+'%. '+a.note;
    const e=data.engine;
    byId('engine').textContent='Refresh: '+e.status.replaceAll('_',' ')+' · Last finished: '+date(e.lastFinished)+'. '+
      (e.busy?'A refresh is running. ': '')+'Up to '+a.maxCandidatesPerRun+' candidates per batch, oldest checked first. Automatic refresh follows the existing six-hour schedule. '+
      (e.summary?'Last batch: '+e.summary.checked+' checked, '+e.summary.priced+' provisional prices, '+e.summary.pending+' pending. ':'');
  }
  async function load(refresh){
    const token=byId('token').value;if(!token){byId('message').textContent='Enter your admin token first.';return;}
    const current=++generation;controller?.abort();controller=new AbortController();byId('load').disabled=true;byId('refresh').disabled=true;
    byId('message').textContent=refresh?'Refreshing supplier research. This may take a minute…':'Loading private reports…';
    try{
      let result;if(refresh){result=await report('/admin/refresh-pricing',token);safety(result);}
      if(current!==generation)return;
      const s=await report('/admin/screening-report',token);let p=await report('/admin/pricing-report',token);safety(p);
      while(p.nextCursor!==null){if(current!==generation)return;const next=await report('/admin/pricing-report?after='+encodeURIComponent(p.nextCursor),token);safety(next);if(next.nextCursor!==null&&next.nextCursor<=p.nextCursor)throw new Error('Invalid report pagination.');p.candidates.push(...next.candidates);p.nextCursor=next.nextCursor;}
      if(current!==generation)return;
      screening(s);pricing(p);byId('token').value='';byId('message').className='safe';
      byId('message').textContent=result?.status==='busy_or_cooling_down'?'A refresh is already running or cooling down. Current reports loaded.':'Private reports loaded. All products remain on hold.';
    }catch(error){if(current!==generation)return;lock();byId('message').textContent=error.message||'Unable to load reports.';byId('message').className='error';}
    finally{if(current===generation){byId('token').value='';byId('load').disabled=false;byId('refresh').disabled=false;controller=null;}}
  }
  byId('load').addEventListener('click',()=>load(false));byId('refresh').addEventListener('click',()=>load(true));byId('lock').addEventListener('click',lock);
})();

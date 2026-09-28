
const CJ_API = "https://developers.cjdropshipping.com/api2.0/v1";

const noStore = {
  "Cache-Control": "no-store"
};

function parseExpiry(value) {
  if (typeof value === "number") {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim()
    .replace(" ", "T")
    .replace(/\.(\d{3})\d+/, ".$1");

  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : normalized + "Z";

  const milliseconds = Date.parse(withTimezone);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

async function getCJAccessToken(env) {
  const now = Date.now();
  const safetyBuffer = 5 * 60 * 1000;

  if (env.TRENDORA_DB) {
    try {
      const cached = await env.TRENDORA_DB.prepare(
        `SELECT access_token, expires_at
         FROM supplier_token_cache
         WHERE supplier = ?`
      ).bind("CJdropshipping").first();

      if (
        cached?.access_token &&
        Number(cached.expires_at) > now + safetyBuffer
      ) {
        return {
          accessToken: cached.access_token,
          source: "cache",
          authenticationDataFields: [],
          httpStatus: 200
        };
      }
    } catch (error) {
      console.warn("CJ token cache read unavailable.");
    }
  }

  const response = await fetch(
    `${CJ_API}/authentication/getAccessToken`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: env.CJ_API_KEY
      })
    }
  );

  const data = await response.json();

  if (
    !response.ok ||
    Number(data.code) !== 200 ||
    !data.data?.accessToken
  ) {
    return {
      accessToken: null,
      source: "supplier",
      httpStatus: response.status,
      supplierCode: data.code ?? null,
      authenticationDataFields: []
    };
  }

  const accessToken = data.data.accessToken;
  const expiresAt = parseExpiry(
    data.data.accessTokenExpiryDate
  );

  if (
    env.TRENDORA_DB &&
    expiresAt !== null &&
    expiresAt > now + safetyBuffer
  ) {
    try {
      await env.TRENDORA_DB.prepare(
        `INSERT INTO supplier_token_cache
          (supplier, access_token, expires_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(supplier) DO UPDATE SET
           access_token = excluded.access_token,
           expires_at = excluded.expires_at,
           updated_at = CURRENT_TIMESTAMP`
      ).bind(
        "CJdropshipping",
        accessToken,
        expiresAt
      ).run();
    } catch (error) {
      console.warn("CJ token cache write unavailable.");
    }
  }

  return {
    accessToken,
    source: "supplier",
    httpStatus: response.status,
    supplierCode: data.code ?? null,
    authenticationDataFields: Object.keys(data.data)
  };
}

// Shared importer for manual and scheduled checks.
// Products are saved privately with no automatic approval.
async function importCandidates(env, accessToken) {
  if (!env.TRENDORA_DB) {
    throw new Error("Database connection unavailable.");
  }

  const importUrl = new URL(`${CJ_API}/product/listV2`);
  importUrl.searchParams.set("page", "1");
  importUrl.searchParams.set("size", "5");

  const response = await fetch(importUrl.toString(), {
    method: "GET",
    headers: {
      "CJ-Access-Token": accessToken
    }
  });

  const data = await response.json();

  if (
    !response.ok ||
    Number(data.code) !== 200 ||
    data.result !== true
  ) {
    throw new Error("CJ catalogue request unsuccessful.");
  }

  const products = data.data?.content?.[0]?.productList;

  if (!Array.isArray(products)) {
    throw new Error("Unexpected CJ product-list format.");
  }

  let added = 0;
  let skipped = 0;

  for (const product of products.slice(0, 5)) {
    if (!product.id || !product.nameEn) {
      skipped++;
      continue;
    }

    const result = await env.TRENDORA_DB.prepare(
      `INSERT OR IGNORE INTO product_candidates (
        supplier,
        supplier_product_id,
        supplier_variant_id,
        product_name,
        product_image,
        supplier_price_usd,
        shipping_cost_usd,
        estimated_delivery_days,
        stock_status,
        review_status,
        screening_status
      )
      SELECT ?, ?, NULL, ?, ?, NULL, NULL, NULL,
             'unverified', 'pending', 'not_checked'
      WHERE NOT EXISTS (
        SELECT 1 FROM product_candidates
        WHERE supplier = ?
          AND supplier_product_id = ?
          AND supplier_variant_id IS NULL
      )`
    ).bind(
      "CJdropshipping",
      String(product.id),
      String(product.nameEn),
      product.bigImage ?? null,
      "CJdropshipping",
      String(product.id)
    ).run();

    if (result.meta?.changes > 0) {
      added++;
    } else {
      skipped++;
    }
  }

  return { added, skipped };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        application: "Trendora API",
        status: "online"
      });
    }

    // Trendora private, read-only dashboard.
    // The page contains no secrets and stores no admin token.
    if (url.pathname === "/dashboard") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...noStore, Allow: "GET" }
        });
      }

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Trendora | Private Dashboard</title>
<style>
:root{font-family:Arial,Helvetica,sans-serif;color:#20283b;background:#f5f7fb}
*{box-sizing:border-box}
body{margin:0}
header{background:#172541;color:white;padding:25px 5%}
header h1{margin:0;font-size:25px}
header p{margin:7px 0 0;color:#d4dfef}
main{max-width:1120px;margin:auto;padding:25px 18px 60px}
.card{background:white;border:1px solid #e2e6ef;border-radius:13px;padding:20px;margin-bottom:18px;box-shadow:0 2px 8px #16213b08}
h2{margin-top:0;font-size:19px}
label{display:block;font-weight:bold;margin-bottom:8px}
input{width:100%;max-width:460px;padding:12px;border:1px solid #aab6cb;border-radius:7px;font-size:16px}
button{padding:12px 18px;background:#176a54;color:white;border:0;border-radius:7px;font-weight:bold;cursor:pointer;margin:12px 8px 0 0}
button.secondary{background:#43526d}
button:disabled{opacity:.55;cursor:wait}
.small{font-size:13px;color:#53617b}
.safe{color:#126347;font-weight:bold}
.warn{color:#925200;font-weight:bold}
.error{color:#aa2737;font-weight:bold}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px}
.stat{background:#f2f6fa;border-radius:8px;padding:14px}
.stat strong{display:block;font-size:25px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:11px;border-bottom:1px solid #e4e8f0;vertical-align:top}
th{background:#f2f6fa}
.tablewrap{overflow-x:auto}
ul{padding-left:20px;margin:5px 0}
li{margin:5px 0}
footer{color:#637087;font-size:12px;margin-top:24px}
</style>
</head>
<body>
<header>
<h1>Trendora · Private Dashboard</h1>
<p>Product research and provisional pricing · Read-only development mode</p>
</header>
<main>
<section class="card">
<h2>Unlock your reports</h2>
<label for="token">Trendora admin token</label>
<input id="token" type="password" autocomplete="off"
       placeholder="Enter your private admin token">
<div>
<button id="load" type="button">Load dashboard</button>
<button id="lock" class="secondary" type="button">Clear and lock</button>
</div>
<p class="small">Your token is used only for these protected requests.
It is not saved in local storage, cookies or the dashboard code.
Closing or refreshing this page clears it.</p>
<p id="message" role="status">Dashboard locked.</p>
</section>

<section class="card">
<h2>Safety controls</h2>
<div class="stats">
<div class="stat">Automatically approved<strong id="approved">—</strong></div>
<div class="stat">Publishing enabled<strong id="publishing">—</strong></div>
<div class="stat">Supplier purchasing<strong id="purchasing">—</strong></div>
<div class="stat">Candidates reviewed<strong id="count">—</strong></div>
</div>
<p class="small">This dashboard has no approval, publishing, ordering or payment buttons.</p>
</section>

<section class="card">
<h2>Private product candidates</h2>
<div class="tablewrap">
<table>
<thead><tr>
<th>ID</th><th>Product</th><th>Screening</th><th>Reasons for hold</th>
</tr></thead>
<tbody id="products"><tr><td colspan="4">Unlock to load products.</td></tr></tbody>
</table>
</div>
</section>

<section class="card">
<h2>Illustrative pricing</h2>
<p class="small">Estimates are not verified profit. Advertising, returns, taxes,
actual exchange rates and supplier charges may change the outcome.</p>
<div class="tablewrap">
<table>
<thead><tr>
<th>Product</th><th>Test price</th><th>Estimated contribution</th>
<th>Gross margin</th><th>Status</th>
</tr></thead>
<tbody id="pricing"><tr><td colspan="5">Unlock to load pricing.</td></tr></tbody>
</table>
</div>
<p id="assumptions" class="small"></p>
</section>
<footer>Trendora internal development dashboard · No checkout or spending controls</footer>
</main>
<script>
(function () {
  "use strict";

  const byId = id => document.getElementById(id);
  const text = (tag, value) => {
    const element = document.createElement(tag);
    element.textContent = value == null ? "—" : String(value);
    return element;
  };
  const money = value =>
    typeof value === "number" ? "£" + value.toFixed(2) : "—";

  function clearTable(id, message) {
    const body = byId(id);
    body.replaceChildren();
    const row = document.createElement("tr");
    const cell = text("td", message);
    cell.colSpan = id === "products" ? 4 : 5;
    row.appendChild(cell);
    body.appendChild(row);
  }

  function lock() {
    byId("token").value = "";
    ["approved","publishing","purchasing","count"].forEach(
      id => byId(id).textContent = "—"
    );
    clearTable("products", "Dashboard locked.");
    clearTable("pricing", "Dashboard locked.");
    byId("assumptions").textContent = "";
    byId("message").textContent = "Dashboard locked.";
    byId("message").className = "";
  }

  async function report(path, token) {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Admin-Token": token }
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Incorrect admin token."
          : "Report request failed (HTTP " + response.status + ")."
      );
    }
    return response.json();
  }

  function renderScreening(data) {
    byId("approved").textContent = data.automaticallyApproved;
    byId("publishing").textContent =
      data.publicationEnabled ? "YES" : "NO";
    byId("purchasing").textContent =
      data.supplierPurchasesEnabled ? "YES" : "NO";
    byId("count").textContent = data.candidateCount;

    const body = byId("products");
    body.replaceChildren();

    for (const product of data.candidates || []) {
      const row = document.createElement("tr");
      row.appendChild(text("td", product.id));
      row.appendChild(text("td", product.productName));
      row.appendChild(text("td", product.screeningOutcome));
      const cell = document.createElement("td");
      const list = document.createElement("ul");
      for (const flag of product.flags || []) {
        list.appendChild(text("li", flag));
      }
      cell.appendChild(list);
      row.appendChild(cell);
      body.appendChild(row);
    }

    if (!data.candidates?.length) {
      clearTable("products", "No candidates found.");
    }
  }

  function renderPricing(data) {
    const body = byId("pricing");
    body.replaceChildren();

    for (const product of data.candidates || []) {
      const row = document.createElement("tr");
      row.appendChild(text("td", product.productName));
      row.appendChild(text("td", money(product.testPriceGbp)));
      row.appendChild(text("td", money(product.estimatedContributionGbp)));
      row.appendChild(text("td",
        typeof product.estimatedGrossMarginPercent === "number"
          ? product.estimatedGrossMarginPercent.toFixed(2) + "%"
          : "—"
      ));
      row.appendChild(text("td", product.status));
      body.appendChild(row);
    }

    if (!data.candidates?.length) {
      clearTable("pricing", "No pricing results found.");
    }

    const a = data.assumptions || {};
    byId("assumptions").textContent =
      "Illustrative assumptions: $1 = £" + a.usdToGbp +
      "; payment fee " + a.paymentFeePercent +
      "% + £" + a.paymentFeeFixedGbp +
      "; minimum contribution £" + a.minimumContributionGbp + ".";
  }

  byId("load").addEventListener("click", async () => {
    const token = byId("token").value;
    if (!token) {
      byId("message").textContent = "Enter your admin token first.";
      return;
    }

    byId("load").disabled = true;
    byId("message").textContent = "Loading protected reports...";

    try {
      const screening = await report("/admin/screening-report", token);
      const pricing = await report("/admin/pricing-report", token);

      if (
        screening.automaticallyApproved !== 0 ||
        screening.publicationEnabled !== false ||
        screening.supplierPurchasesEnabled !== false ||
        pricing.publicationEnabled !== false ||
        pricing.supplierPurchasesEnabled !== false
      ) {
        throw new Error("Safety setting mismatch. Reports not displayed.");
      }

      renderScreening(screening);
      renderPricing(pricing);
      byId("message").textContent = "Reports loaded successfully.";
      byId("message").className = "safe";
      byId("token").value = "";
    } catch (error) {
      lock();
      byId("message").textContent = error.message || "Unable to load reports.";
      byId("message").className = "error";
    } finally {
      byId("load").disabled = false;
    }
  });

  byId("lock").addEventListener("click", lock);
})();
</script>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; " +
            "style-src 'unsafe-inline'; connect-src 'self'; " +
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }
      });
    }


    const adminRoutes = [
      "/admin/test-cj",
      "/admin/test-products",
      "/admin/test-product-details",
      "/admin/test-db",
      "/admin/candidates",
      "/admin/import-candidates",
      "/admin/screening-report",
      "/admin/pricing-report"
    ];

    if (!adminRoutes.includes(url.pathname)) {
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: noStore }
      );
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          ...noStore,
          Allow: "POST"
        }
      });
    }

    const suppliedToken = request.headers.get("X-Admin-Token");

    if (
      !env.TRENDORA_ADMIN_TOKEN ||
      !suppliedToken ||
      suppliedToken !== env.TRENDORA_ADMIN_TOKEN
    ) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: noStore }
      );
    }

    try {
      if (url.pathname === "/admin/test-db") {
        if (!env.TRENDORA_DB) {
          return Response.json({
            database: "trendora-catalogue",
            connected: false,
            message: "D1 binding is missing."
          }, {
            status: 503,
            headers: noStore
          });
        }

        const result = await env.TRENDORA_DB.prepare(
          "SELECT COUNT(*) AS candidateCount FROM product_candidates"
        ).first();

        return Response.json({
          database: "trendora-catalogue",
          connected: true,
          candidateCount: result?.candidateCount ?? 0
        }, { headers: noStore });
      }

      if (url.pathname === "/admin/candidates") {
        if (!env.TRENDORA_DB) {
          return Response.json(
            { error: "Database connection unavailable." },
            { status: 503, headers: noStore }
          );
        }

        const result = await env.TRENDORA_DB.prepare(
          `SELECT
            id,
            supplier,
            supplier_product_id,
            supplier_variant_id,
            product_name,
            product_image,
            supplier_price_usd,
            shipping_cost_usd,
            estimated_delivery_days,
            stock_status,
            review_status,
            screening_status,
            screening_notes,
            created_at
           FROM product_candidates
           ORDER BY created_at DESC, id DESC
           LIMIT 50`
        ).all();

        return Response.json({
          candidateCount: result.results.length,
          candidates: result.results
        }, { headers: noStore });
      }

      // Private, read-only product screening.
      if (url.pathname === "/admin/screening-report") {
        if (!env.TRENDORA_DB) {
          return Response.json(
            { error: "Database connection unavailable." },
            { status: 503, headers: noStore }
          );
        }

        const result = await env.TRENDORA_DB.prepare(
          `SELECT id, product_name, supplier_price_usd,
                  shipping_cost_usd, estimated_delivery_days,
                  stock_status, review_status, screening_status,
                  screening_notes
           FROM product_candidates
           ORDER BY id DESC LIMIT 50`
        ).all();

        const candidates = result.results.map(product => {
          const name = String(
            product.product_name || ""
          ).toLowerCase();

          const flags = [];

          if (
            /\blip(?:stick|gloss| balm| mud)?\b|cosmetic|makeup|skin care|serum|perfume/.test(name)
          ) {
            flags.push(
              "Cosmetics: additional UK compliance review needed"
            );
          }

          if (/briefs|underwear|lingerie/.test(name)) {
            flags.push(
              "Intimate apparel: additional returns and hygiene review needed"
            );
          }

          if (
            /earring|pendant|necklace|jewellery|jewelry/.test(name)
          ) {
            flags.push(
              "Jewellery: material and UK product-safety claims need checking"
            );
          }

          if (product.supplier_price_usd == null) {
            flags.push(
              "Supplier price missing or currency unverified"
            );
          }

          if (product.shipping_cost_usd == null) {
            flags.push("UK shipping cost missing");
          }

          if (!product.estimated_delivery_days) {
            flags.push("Full delivery estimate unverified");
          }

          if (product.stock_status !== "verified") {
            flags.push("Variant and stock unverified");
          }

          flags.push(
            "GBP retail price, exchange rate and selling fees not verified"
          );

          return {
            id: product.id,
            productName: product.product_name,
            reviewStatus: product.review_status,
            screeningStatus: product.screening_status,
            screeningNotes: product.screening_notes,
            screeningOutcome: "hold_for_manual_review",
            flags
          };
        });

        return Response.json({
          candidateCount: candidates.length,
          automaticallyApproved: 0,
          publicationEnabled: false,
          supplierPurchasesEnabled: false,
          candidates
        }, { headers: noStore });
      }

      // Private illustrative pricing calculator.
      // Does not change prices or approve products.
      if (url.pathname === "/admin/pricing-report") {
        if (!env.TRENDORA_DB) {
          return Response.json(
            { error: "Database connection unavailable." },
            { status: 503, headers: noStore }
          );
        }

        const rows = await env.TRENDORA_DB.prepare(
          `SELECT id, product_name, supplier_price_usd,
                  shipping_cost_usd, stock_status, review_status
           FROM product_candidates
           ORDER BY id DESC LIMIT 50`
        ).all();

        const assumptions = {
          usdToGbp: 0.76,
          paymentFeePercent: 1.5,
          paymentFeeFixedGbp: 0.20,
          minimumContributionGbp: 5,
          note: "Illustrative only: FX, fees, supplier charges and taxes not verified."
        };

        const round = value =>
          Math.round((value + Number.EPSILON) * 100) / 100;

        const candidates = rows.results.map(product => {
          const testPriceGbp =
            product.id === 1 ? 17.99 : null;

          const hasCosts =
            Number.isFinite(product.supplier_price_usd) &&
            Number.isFinite(product.shipping_cost_usd) &&
            product.supplier_price_usd >= 0 &&
            product.shipping_cost_usd >= 0;

          if (!hasCosts || testPriceGbp === null) {
            return {
              id: product.id,
              productName: product.product_name,
              testPriceGbp,
              estimatedContributionGbp: null,
              estimatedGrossMarginPercent: null,
              status: "hold_missing_costs_or_test_price",
              reason: "No complete supplier cost or internal GBP test price."
            };
          }

          const costGbp =
            (product.supplier_price_usd +
              product.shipping_cost_usd) *
            assumptions.usdToGbp;

          const feeGbp =
            testPriceGbp *
              assumptions.paymentFeePercent / 100 +
            assumptions.paymentFeeFixedGbp;

          const contribution =
            testPriceGbp - costGbp - feeGbp;

          const grossMargin =
            (testPriceGbp - costGbp) /
            testPriceGbp * 100;

          return {
            id: product.id,
            productName: product.product_name,
            testPriceGbp,
            estimatedSupplierAndShippingGbp: round(costGbp),
            estimatedPaymentFeeGbp: round(feeGbp),
            estimatedContributionGbp: round(contribution),
            estimatedGrossMarginPercent: round(grossMargin),
            meetsIllustrativeFivePoundThreshold:
              contribution >= assumptions.minimumContributionGbp,
            status: "hold_unverified_fx_fees_stock_and_market_price",
            reason: "Illustrative figures are not verified profitability or product approval."
          };
        });

        return Response.json({
          assumptions,
          automaticallyApproved: 0,
          publicationEnabled: false,
          supplierPurchasesEnabled: false,
          candidates
        }, { headers: noStore });
      }

      if (!env.CJ_API_KEY) {
        return Response.json({
          supplier: "CJdropshipping",
          connected: false,
          message: "CJ API key is not configured."
        }, {
          status: 503,
          headers: noStore
        });
      }

      const auth = await getCJAccessToken(env);

      if (!auth.accessToken) {
        return Response.json({
          supplier: "CJdropshipping",
          connected: false,
          message: "Supplier authentication was unsuccessful.",
          httpStatus: auth.httpStatus,
          supplierCode: auth.supplierCode ?? null
        }, {
          status: 502,
          headers: noStore
        });
      }

      if (url.pathname === "/admin/test-cj") {
        return Response.json({
          supplier: "CJdropshipping",
          connected: true,
          authenticationSource: auth.source,
          httpStatus: auth.httpStatus,
          authenticationDataFields:
            auth.authenticationDataFields
        }, { headers: noStore });
      }

      if (url.pathname === "/admin/import-candidates") {
        const result = await importCandidates(
          env,
          auth.accessToken
        );

        return Response.json({
          importMode: "manual",
          ...result,
          authenticationSource: auth.source,
          reviewStatus: "pending",
          stockStatus: "unverified",
          message: "Candidates saved privately. No products published."
        }, { headers: noStore });
      }

      if (url.pathname === "/admin/test-product-details") {
        const detailsUrl = new URL(
          `${CJ_API}/product/query`
        );

        detailsUrl.searchParams.set(
          "pid",
          "1363726889776189440"
        );

        const detailsResponse = await fetch(
          detailsUrl.toString(),
          {
            method: "GET",
            headers: {
              "CJ-Access-Token": auth.accessToken
            }
          }
        );

        const detailsData = await detailsResponse.json();

        return Response.json({
          test: "CJ Product Details",
          authenticationSource: auth.source,
          httpStatus: detailsResponse.status,
          supplierCode: detailsData.code ?? null,
          supplierSuccess: detailsData.result ?? null,
          supplierMessage: detailsData.message ?? null,
          productFields:
            detailsData.data &&
            typeof detailsData.data === "object"
              ? Object.keys(detailsData.data)
              : [],
          productProPreview:
            typeof detailsData.data?.productPro === "string"
              ? detailsData.data.productPro.slice(0, 500)
              : detailsData.data?.productPro ?? null,
          variantCount:
            Array.isArray(detailsData.data?.variants)
              ? detailsData.data.variants.length
              : 0,
          variantFields:
            detailsData.data?.variants?.[0]
              ? Object.keys(detailsData.data.variants[0])
              : [],
          variantPreview:
            Array.isArray(detailsData.data?.variants)
              ? detailsData.data.variants.slice(0, 3).map(
                  variant => ({
                    vid: variant.vid,
                    name: variant.variantNameEn,
                    sku: variant.variantSku,
                    listedPrice: variant.variantSellPrice,
                    suggestedPrice: variant.variantSugSellPrice,
                    weight: variant.variantWeight,
                    inventoryNum: variant.inventoryNum,
                    inventoryLocations:
                      Array.isArray(variant.inventories)
                        ? variant.inventories.map(stock => ({
                            warehouseId: stock.warehouseId,
                            inventoryNum: stock.inventoryNum
                          }))
                        : []
                  })
                )
              : []
        }, { headers: noStore });
      }

      // Read-only five-product supplier catalogue preview.
      const productUrl = new URL(
        `${CJ_API}/product/listV2`
      );

      productUrl.searchParams.set("page", "1");
      productUrl.searchParams.set("size", "5");

      const productResponse = await fetch(
        productUrl.toString(),
        {
          method: "GET",
          headers: {
            "CJ-Access-Token": auth.accessToken
          }
        }
      );

      const productData = await productResponse.json();

      const productList =
        productData.data?.content?.[0]?.productList;

      return Response.json({
        supplier: "CJdropshipping",
        test: "Product List V2",
        authenticationSource: auth.source,
        httpStatus: productResponse.status,
        supplierCode: productData.code ?? null,
        supplierSuccess: productData.result ?? null,
        supplierMessage: productData.message ?? null,
        responseFields:
          productData.data &&
          typeof productData.data === "object"
            ? Object.keys(productData.data)
            : [],
        productCount:
          Array.isArray(productList)
            ? productList.length
            : 0,
        productPreview:
          Array.isArray(productList)
            ? productList.slice(0, 5).map(product => ({
                id: product.id,
                name: product.nameEn,
                image: product.bigImage,
                supplierListedPrice:
                  product.nowPrice ?? product.sellPrice,
                currency: product.currency,
                category: product.oneCategoryName,
                deliveryCycle: product.deliveryCycle
              }))
            : []
      }, { headers: noStore });

    } catch (error) {
      console.error(
        "Trendora protected request failed:",
        error instanceof Error ? error.message : "Unknown error"
      );

      return Response.json({
        connected: false,
        message: "The requested operation could not be completed."
      }, {
        status: 502,
        headers: noStore
      });
    }
  },

  // Four daily private catalogue checks.
  // No publishing, checkout or supplier purchases.
  async scheduled(event, env, ctx) {
    try {
      if (!env.TRENDORA_DB || !env.CJ_API_KEY) {
        console.error(
          "Scheduled import: required binding missing."
        );
        return;
      }

      const auth = await getCJAccessToken(env);

      if (!auth.accessToken) {
        console.error(
          "Scheduled import: CJ authentication failed."
        );
        return;
      }

      const result = await importCandidates(
        env,
        auth.accessToken
      );

      console.log(
        "Trendora scheduled catalogue check completed",
        {
          ...result,
          authenticationSource: auth.source
        }
      );

    } catch (error) {
      console.error(
        "Trendora scheduled catalogue check failed:",
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
};

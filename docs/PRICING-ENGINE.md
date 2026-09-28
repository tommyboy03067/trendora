# Trendora private pricing engine

This extends the inspected Worker and leaves the demo storefront untouched. Checkout, product publication, approvals and supplier purchases remain disabled. No subscription or paid API is introduced.

## Build and check

Requires Node 24 (tests use its built-in SQLite). No package installation is required:

```
node scripts/build.mjs
node --check dist/worker.mjs
node --test tests/pricing.test.mjs
```

`worker/baseline.mjs` is the source copied from deployed version c495f2e8 before editing. Keep it immutable. `worker/pricing-engine.mjs` owns the new engine; `worker/dashboard.js` owns the dashboard script. The build replaces the old pricing route and browser script and adds a protected refresh route. All diagnostic endpoints, token caching, importer duplicate protection and screening rules are retained.

## Use

Open the existing `/dashboard`, enter the existing admin token locally, and choose **Refresh product research**. This researches up to ten candidates and then reloads both reports. **Load dashboard** only reads reports. The token is never embedded in code or persisted in browser storage. Clear and lock cancels display of any in-flight report.

Automatic research uses the existing six-hour cron. The oldest attempted candidates are processed first, including failed candidates, so the bounded batch eventually covers the whole catalogue. The original importer runs after a completed research batch; it defers during research quota/authentication/service failures. New imports are researched in a subsequent batch. The pricing report paginates in batches of 100 and the dashboard loads every page; the separate original screening report retains its 50-item limit.

## Selection policy

- Retain a candidate's existing variant ID exactly. Never silently substitute a missing saved variant.
- For product-level candidates, inspect returned variants and select a representative with the lowest strictly positive CJ variant price; tie-break by variant ID. This is only one representative, not a guarantee of the lowest landed cost, and never changes the candidate's saved variant ID. Other variants remain unquoted.
- Require positive CJ-managed warehouse stock for that variant; factory-only inventory remains pending. Prefer GB stock, then CN, then alphabetical country code. Counts are supplier-reported and unreserved, not independent verification.
- Request one-unit freight to GB from the selected origin. Choose the lowest quoted total with numeric transit no more than 15 days; ties prefer faster maximum transit then method name. The 15-day ceiling is an internal selection assumption. This is a country-level estimate, not an address-specific checkout quote or a tracking guarantee.
- Include quoted tax and clearance amounts. Use a supplied total without double-counting components and reject inconsistent totals. Missing charges are flagged, not fabricated as verified zero.
- Transit never includes invented processing time. Full delivery and processing remain unverified.

## Pricing and evidence

Frankfurter v2 provides dated USD/GBP reference data without a key. Future-dated, malformed and older-than-seven-day rates are rejected; a previously saved valid rate may be reused. These reference rates are not actual card conversion rates.

Assumptions: 2% FX buffer, 1.5% payment fee plus £0.20, £5 minimum estimated contribution and a 40% gross margin target. Costs and fees round upward to pence. The next .99 price that satisfies both constraints is used; a contribution constraint may legitimately result in higher margins. Advertising, returns, overhead and unquoted taxes/VAT are excluded, so contribution is not verified net profit.

Supplier evidence expires after 24 hours. Failed research, missing costs/stock/freight, changed variant identity or invalid FX yields **Price pending verification**. A failed attempt retains previous evidence and last-good JSON but does not pass it off as a fresh price. All products remain on hold regardless of the estimate.

## Database, safety and operations

The first refresh runs an atomic, repeatable additive migration: `pricing_snapshots_v1`, its attempted-time index, and `pricing_control_v1`. It never alters the existing catalogue/token schema or updates legacy candidate rows, review decisions or costs. The snapshot primary key prevents duplicate pricing rows. Token caching continues to use the pre-existing token table.

A conditional D1 update acquires a ten-minute lease; overlapping refreshes are rejected. Work stops at eight minutes, leaving timeout headroom. There is at least a minute between completed runs, and a ten-minute minimum cooldown after service/rate/authentication errors. The supplier client is serial, spaced by at least 1.1 seconds and capped at 32 calls per batch; it respects reported points and HTTP/body rate-limit signals. It makes no immediate retry storm. Further retries are through the next scheduled run or an explicitly requested refresh after cooldown.

Logs include run counts and candidate IDs/error categories only. They do not include supplier/admin credentials or raw supplier bodies. The report and refresh endpoint use the existing X-Admin-Token protection, POST method checks and no-store headers.

For a refresh that is interrupted by Cloudflare, the lease expires automatically; saved snapshots remain intact. Free-plan runtime limits or supplier account restrictions can reduce a batch's coverage. Inspect dashboard timestamps and the run summary rather than treating a deployed scheduler as proof of successful research.

## Rollback

Preferred rollback: in Cloudflare Deployments restore the previous Worker version beginning **c495f2e8**, or redeploy `worker/baseline.mjs` while retaining the existing bindings/secrets/cron. The two new tables can safely remain: the previous Worker does not use them. Do not delete or restore the entire catalogue merely to roll back code.

A pre-change D1 recovery bookmark is retained in the local operations handover. Restoring the database replaces newer state and requires separate approval; prefer a code rollback. No database restore has been performed.

## Official API references

- https://developers.cjdropshipping.com/en/api/api2/api/product.html
- https://developers.cjdropshipping.com/en/api/api2/api/logistic.html
- https://developers.cjdropshipping.com/en/api/api2/standard/points.html
- https://frankfurter.dev/


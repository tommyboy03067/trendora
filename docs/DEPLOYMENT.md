# Deployment verification — 28 September 2026

Worker version `a4dfc4e5` is active. Previous version `c495f2e8` is retained for code rollback.

- Production `/health`: HTTP 200, online.
- Production dashboard: new research controls available, no-store headers retained.
- Unauthenticated POST pricing report and refresh: HTTP 401.
- Original demo storefront has not been edited.
- Local verification: 17 tests pass; the compact deployed bundle also passed the same 17 tests and a syntax check. The entire Cloudflare editor buffer was compared exactly with the tested compact source before deployment.
- An initial scheduled run at 00:00 UTC encountered a supplier rate limit and stopped safely.
- Manual live refresh at 04:29:30 UTC completed: 10 checked, 0 provisional prices, 10 pending. All selected variants failed the positive CJ-managed warehouse stock requirement. This does not prove that all variants are unavailable or that factory inventory is zero.
- The successful run retrieved USD/GBP reference FX 0.75436 dated 2026-09-28.
- Dashboard safety controls showed 0 automatically approved, publishing NO, supplier purchasing NO.

The full successful-price path is covered by controlled fixtures, but was not exercised with a qualifying live product: none of the existing selected variants passed the stock gate. Do not describe the current candidates as fully priced. The engine retries through the existing six-hour schedule and leaves incomplete evidence pending.

No admin or supplier secret was copied into source, documentation, or test data. The owner entered their existing admin token directly in the live dashboard; it was cleared by the dashboard after use.

Database validation after the live run: 10 candidates, 10 still marked pending, 10 pricing snapshot rows, status completed, 20 supplier calls, and lock released (lock_until=0).

Deployment artifact: the active source was compacted with Terser 5.44.0 (`--module --compress --mangle --format ascii_only=true`) for the Cloudflare web editor. The normal `dist/worker.mjs` build is readable and functionally equivalent; compacting is optional.

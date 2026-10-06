# Promotions, offers and coupons: backend gap (D7)

Status: SPECIFICATION GAP, not scheduled. Separate from banner/channel publishing, which is only content.

## What exists on backend main (c3306b6, static audit)

- Price per SKU: `sellingPricePaise`, `mrpPaise`, effective window, server-derived discount amount/percent (`pricing/Price.java`).
- Membership benefits: plan-based discount rules in basis points (`benefits/*`).
- Checkout states explicitly: no coupons, no spendable Coins, no wallet (`OrderMoneySnapshot.java:10`, `OrderService.java:108`).
- `campaigns` / `campaign_membership` collections exist only in bootstrap schema (`SchemaBootstrap.java:31,237`) with no service code.
- `offers_current.channel` is legacy marketplace ingest with no callers; it is not a customer-channel concept.

## What is missing for real promotions

Offer model (type, value, eligibility, product/category scope, stacking rules), validity windows, usage limits, coupon codes and
redemption, checkout price integration with an immutable money snapshot, per-channel eligibility if wanted, admin CRUD with
audit and version checks, public read contract, and tests that prove checkout totals. Each needs a product decision (stacking,
refund treatment, funding) before design.

## CMS consequence

None built now. A banner can say anything, but it must not imply a discount the backend will not honour. When a promotions
contract exists, the CMS gets a Promotions module; until then pricing stays selling price + MRP only.

## Next step

Product owner to specify offer types and stacking rules; backend to produce a contract proposal for review.

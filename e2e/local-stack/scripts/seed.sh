#!/usr/bin/env bash
# Seed the local backend the way the ITs do:
#  - taxonomy: the migration runner applied the frozen seed at startup; activate release R1 through the CMS API
#    (LOCAL_DEVELOPMENT.md §2);
#  - products: validator-conformant documents inserted exactly like AbstractConsumerIT.product(...) (active, confirmed,
#    vertical TZV-000001 "Basmati Rice", release R1). Ids are numeric (TZP-9000010x) because the app's rail mapping
#    accepts only ^TZP-[0-9]+$;
#  - prices: through the admin API (PUT /api/v1/admin/prices/{sku}); with tazzzo.freshness.enabled the write enqueues the
#    card-projection rebuild that grids/rails read.
# Idempotent: re-running replaces the product documents and skips existing prices.
source "$(dirname "$0")/common.sh"
ensure_env
H="Authorization: Bearer $E2E_CMS_TOKEN"

echo "== taxonomy release R1"
curl -s -o /dev/null -w "create R1 -> %{http_code}\n" -X POST "$E2E_BACKEND/api/v1/taxonomy/releases" -H "$H" \
  -H 'Content-Type: application/json' -d '{"releaseId":"R1","basedOn":null}'
curl -s -o /dev/null -w "publish R1 -> %{http_code}\n" -X POST "$E2E_BACKEND/api/v1/taxonomy/releases/R1/publish" -H "$H"

echo "== products (direct insert, as AbstractConsumerIT.product)"
docker exec -i tazzzo-e2e-mongo mongosh --quiet "mongodb://localhost:$MONGO_PORT/tazzzo_e2e?replicaSet=rs0" <<'JS'
const items = [
  ['TZP-90000101', 'Local E2E Basmati Rice 5 kg'],
  ['TZP-90000102', 'Local E2E Brown Basmati 1 kg'],
  ['TZP-90000103', 'Local E2E Sona Masoori 10 kg'],
];
for (const [id, title] of items) {
  const doc = { _id: id, product_type: 'single', identity: { type: 'internal', internal_key: id }, brand_code: 'BR',
    title, lifecycle: 'active', classification: { vertical_id: 'TZV-000001', release_id: 'R1', status: 'confirmed' },
    attributes: {}, attributes_meta: { validated_release: 'R1' }, version: 1, created_at: new Date() };
  const r = db.products.replaceOne({ _id: id }, doc, { upsert: true });
  print(`${id} upserted=${r.upsertedCount} modified=${r.modifiedCount}`);
}
JS

echo "== prices (admin API)"
for p in TZP-90000101:24900:29900 TZP-90000102:15900:17900 TZP-90000103:89900:99900; do
  IFS=: read -r sku sell mrp <<< "$p"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$E2E_BACKEND/api/v1/admin/prices/$sku" -H "$H")
  if [[ "$code" == 200 ]]; then echo "$sku price exists"; continue; fi
  curl -s -o /dev/null -w "$sku price -> %{http_code}\n" -X PUT "$E2E_BACKEND/api/v1/admin/prices/$sku" -H "$H" \
    -H 'Content-Type: application/json' -d "{\"sellingPricePaise\":$sell,\"mrpPaise\":$mrp,\"currency\":\"INR\"}"
done

echo "== wait for the card projection (grid/rail cards)"
for _ in $(seq 1 30); do
  n=$(curl -s "$E2E_BACKEND/v1/categories/TZV-000001/products?page_size=24" | grep -o '"productId"' | wc -l | tr -d ' ')
  [[ "$n" -ge 3 ]] && break
  sleep 1
done
echo "TZV-000001 list: $n products"
for id in TZP-90000101 TZP-90000102 TZP-90000103; do
  curl -s -o /dev/null -w "GET /v1/products/$id -> %{http_code}\n" "$E2E_BACKEND/v1/products/$id"
done

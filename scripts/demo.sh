#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:3000"
OTA="http://localhost:4000"
AEGEAN_KEY="demo-aegean-key"
OLIVE_KEY="demo-olive-key"

PROPERTY1="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
DBL_RT="cccccccc-cccc-cccc-cccc-cccccccccccc"
SUI_RT="dddddddd-dddd-dddd-dddd-dddddddddddd"
OTA_CHANNEL_ID="f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0"

ARRIVAL=$(date -d "+30 days" +%Y-%m-%d 2>/dev/null || date -v+30d +%Y-%m-%d)
DEPARTURE=$(date -d "+32 days" +%Y-%m-%d 2>/dev/null || date -v+32d +%Y-%m-%d)

echo "=== StayHub Demo ==="
echo "Arrival: $ARRIVAL  Departure: $DEPARTURE"
echo ""

# ---- 1. Health ----
echo "--- 1. Health check ---"
curl -sf "$API/health" | python3 -m json.tool
echo ""

# ---- 2. Properties ----
echo "--- 2. List properties (Aegean) ---"
curl -sf -H "x-api-key: $AEGEAN_KEY" "$API/v1/properties" | python3 -m json.tool | head -40
echo ""

# ---- 3. Set level L4 ----
echo "--- 3. Set price level L4 for arrival period ---"
curl -sf -X PUT "$API/v1/yield/levels" \
  -H "x-api-key: $AEGEAN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\":\"$PROPERTY1\",\"level_code\":\"L4\",\"from\":\"$ARRIVAL\",\"to\":\"$DEPARTURE\"}" \
  | python3 -m json.tool
echo ""

# ---- 4. Wait for worker to push ARI ----
echo "--- 4. Waiting 3s for worker to push ARI to mock OTA ---"
sleep 3

# ---- 5. Check OTA has received the ARI ----
echo "--- 5. OTA ARI grid (first few entries) ---"
curl -sf "$OTA/ari" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for room,rates in data.get('grid',{}).items():
  for rate,nights in rates.items():
    items = sorted(nights.items())[:3]
    for night,info in items:
      print(f'  {room}/{rate} {night}: price={info[\"price\"]:.2f} free={info[\"free\"]}')
"
echo ""

# ---- 6. Availability search ----
echo "--- 6. Availability search (web channel, 2 adults) ---"
curl -sf -G "$API/v1/availability" \
  -H "x-api-key: $AEGEAN_KEY" \
  --data-urlencode "property_id=$PROPERTY1" \
  --data-urlencode "arrival=$ARRIVAL" \
  --data-urlencode "departure=$DEPARTURE" \
  --data-urlencode "adults=2" \
  --data-urlencode "channel=web" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)
for o in data['offers'][:4]:
  print(f'  {o[\"roomTypeCode\"]} {o[\"ratePlanCode\"]} total={o[\"totalAmount\"]} available={o[\"available\"]}')
"
echo ""

# ---- 7. Get rate plan IDs ----
BAR_ID=$(curl -sf -H "x-api-key: $AEGEAN_KEY" "$API/v1/properties" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(rp['id']) for p in d['properties'] for rp in p['rate_plans'] if rp['code']=='BAR']" | head -1)
WEB_CH_ID=$(curl -sf -H "x-api-key: $AEGEAN_KEY" "$API/v1/properties" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(ch['id']) for p in d['properties'] for ch in p['channels'] if ch['code']=='web']" | head -1)
NR_ID=$(curl -sf -H "x-api-key: $AEGEAN_KEY" "$API/v1/properties" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(rp['id']) for p in d['properties'] for rp in p['rate_plans'] if rp['code']=='NR']" | head -1)

echo "BAR plan: $BAR_ID"
echo "NR plan:  $NR_ID"
echo "Web ch:   $WEB_CH_ID"
echo ""

# ---- 8. Direct booking: hold -> confirm ----
echo "--- 7. Direct booking: hold ---"
HOLD_RESP=$(curl -sf -X POST "$API/v1/bookings/hold" \
  -H "x-api-key: $AEGEAN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\":\"$PROPERTY1\",\"rate_plan_id\":\"$BAR_ID\",\"room_type_id\":\"$DBL_RT\",\"channel_id\":\"$WEB_CH_ID\",\"adults\":2,\"arrival\":\"$ARRIVAL\",\"departure\":\"$DEPARTURE\"}")
echo "$HOLD_RESP" | python3 -m json.tool
RES_ID=$(echo "$HOLD_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['reservationId'])")
echo ""

echo "--- 8. Confirm booking ---"
curl -sf -X POST "$API/v1/bookings/$RES_ID/confirm" \
  -H "x-api-key: $AEGEAN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payment_token":"tok-visa-valid"}' \
  | python3 -m json.tool
echo ""

# ---- 9. Wait for worker ----
echo "--- 9. Wait 3s for OTA ARI to reflect direct booking ---"
sleep 3

# ---- 10. OTA sees reduced availability ----
echo "--- 10. OTA availability after direct booking ---"
curl -sf "$OTA/ari" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for room,rates in data.get('grid',{}).items():
  for rate,nights in rates.items():
    for night,info in sorted(nights.items())[:2]:
      print(f'  {room}/{rate} {night}: free={info[\"free\"]}')
"
echo ""

# ---- 11. OTA simulates a booking ----
echo "--- 11. OTA simulates booking (2 nights) ---"
OTA_RESP=$(curl -sf -X POST "$OTA/simulate/booking" \
  -H "Content-Type: application/json" \
  -d "{\"room_code\":\"OTA_DBL\",\"rate_code\":\"OTA_BAR\",\"arrival\":\"$ARRIVAL\",\"departure\":\"$DEPARTURE\",\"adults\":2,\"rate_plan_id\":\"$BAR_ID\",\"room_type_id\":\"$DBL_RT\"}")
echo "$OTA_RESP" | python3 -m json.tool
OTA_EXT_REF=$(echo "$OTA_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('externalRef',''))" 2>/dev/null || echo "")
echo ""

# ---- 12. Check availability is consistent ----
echo "--- 12. Availability after both bookings (should show reduced inventory) ---"
curl -sf -G "$API/v1/availability" \
  -H "x-api-key: $AEGEAN_KEY" \
  --data-urlencode "property_id=$PROPERTY1" \
  --data-urlencode "arrival=$ARRIVAL" \
  --data-urlencode "departure=$DEPARTURE" \
  --data-urlencode "adults=2" \
  --data-urlencode "channel=web" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)
for o in data['offers'][:3]:
  print(f'  {o[\"roomTypeCode\"]} {o[\"ratePlanCode\"]} available={o[\"available\"]} total={o[\"totalAmount\"]}')
"
echo ""

# ---- 13. Stop sell via OTA ----
echo "--- 13. Set stop-sell on SUI for period ---"
curl -sf -X PUT "$API/v1/inventory/stop-sell" \
  -H "x-api-key: $AEGEAN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"room_type_id\":\"$SUI_RT\",\"from\":\"$ARRIVAL\",\"to\":\"$DEPARTURE\",\"stop_sell\":true}" \
  | python3 -m json.tool
echo ""

echo "--- 14. Wait 3s then check OTA sees stop_sell ---"
sleep 3
curl -sf "$OTA/ari" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for room,rates in data.get('grid',{}).items():
  if 'SUI' in room:
    for rate,nights in rates.items():
      for night,info in sorted(nights.items())[:2]:
        print(f'  {room}/{rate} {night}: free={info[\"free\"]} stopSell={info[\"stopSell\"]}')
"
echo ""

echo "=== Demo complete ==="

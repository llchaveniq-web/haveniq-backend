#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# HavenIQ backend smoke test.
#
# Hits every route that should exist and confirms it responds with the
# right status code. NOT a unit test — it just verifies routes are wired
# and reachable. Run after every deploy:
#
#   bash smoke-test.sh
#   bash smoke-test.sh https://haveniq-backend-staging.up.railway.app
#
# Expected pass output: every line ends with " ✓".
# Any " ✗" means a route is missing or broken.
# ─────────────────────────────────────────────────────────────────────────

BASE="${1:-https://haveniq-backend-production.up.railway.app}"
PASS=0
FAIL=0

check() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE$path")
  if [ "$actual" = "$expected" ]; then
    echo "  $method $path → $actual (expected $expected) ✓ — $label"
    PASS=$((PASS + 1))
  else
    echo "  $method $path → $actual (expected $expected) ✗ — $label"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Smoke-testing $BASE"
echo "──────────────────────────────────────────────────────────────"

# Public — no auth needed
check GET  /health                                  200 "health endpoint alive"
check GET  /users/signup-stats?school=Orange%20Coast%20College 200 "signup-stats public endpoint"

# Auth-required: 401 = route exists, requires auth (correct behavior)
check GET  /users/me                                401 "users.me requires auth"
check GET  /users/me/viewers                        401 "users.me/viewers requires auth"
check GET  /matches/feed                            401 "matches feed requires auth"
check GET  /matches/requests                        401 "matches requests requires auth"
check POST /matches/connect                         401 "matches connect requires auth"
check POST /matches/respond                         401 "matches respond requires auth"
check POST /quiz/save                               401 "quiz save requires auth"
check GET  /quiz/progress                           401 "quiz progress requires auth"
check POST /quiz/submit                             401 "quiz submit requires auth"
check GET  /messages/conversations                  401 "messages list requires auth"
check GET  /messages/00000000-0000-0000-0000-000000000000 401 "messages thread requires auth"
check POST /telemetry/batch                         401 "telemetry batch requires auth"
check GET  /telemetry/my-data                       401 "telemetry export requires auth"
check POST /telemetry/consent                       401 "telemetry consent requires auth"
check POST /reviews                                 401 "reviews create requires auth"
check GET  /reviews/user/00000000-0000-0000-0000-000000000000 401 "reviews list requires auth"
check GET  /pulses/pending                          401 "pulses pending requires auth"
check POST /pulses                                  401 "pulses submit requires auth"
check GET  /checklists/00000000-0000-0000-0000-000000000000 401 "checklists fetch requires auth"
check PATCH /checklists/00000000-0000-0000-0000-000000000000 401 "checklists update requires auth"
check POST /groups                                  401 "groups create requires auth"
check GET  /groups/me                               401 "groups list requires auth"
check GET  /groups/00000000-0000-0000-0000-000000000000 401 "groups detail requires auth"
check POST /groups/00000000-0000-0000-0000-000000000000/join 401 "groups join requires auth"
check GET  /groups/feed                             401 "groups feed requires auth"
check POST /groups/00000000-0000-0000-0000-000000000000/express-interest 401 "groups express-interest requires auth"
check GET  /search?q=test                           401 "search requires auth"
check POST /quiz/preview-matches                    401 "quiz preview-matches requires auth"
check DELETE /quiz/reset                            401 "quiz reset requires auth"
check GET  /quiz/snapshots                          401 "quiz snapshots requires auth"

# Auth flow endpoints — 400 = exists but rejects empty body (correct)
check POST /auth/send-code                          400 "auth send-code rejects empty body"
check POST /auth/verify-code                        400 "auth verify-code rejects empty body"

# Regression guards against old broken URLs.
# /messages/send returns 401 (not 404) because Express matches it against
# the `/:conversationId` param-route — that's harmless: the conversation
# id "send" would never be a valid UUID, so even if auth passed the next
# layer rejects. Documenting expected behavior, not changing it.
check POST /messages/send                           401 "old /messages/send absorbs into :conversationId (harmless)"
check GET  /messages/conversations/x/messages       404 "old broken nested message URL is dead"

echo "──────────────────────────────────────────────────────────────"
echo "  PASS: $PASS    FAIL: $FAIL"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

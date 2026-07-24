#!/bin/sh
# 순수 로직 테스트 일괄 실행 (JavaScriptCore). node가 있으면 node로도 가능.
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
RUN="$JSC"; command -v node >/dev/null 2>&1 && [ ! -x "$JSC" ] && RUN=node
DIR=$(dirname "$0")
fail=0
for f in "$DIR"/cs-desk-dismiss-sort.test.js "$DIR"/urlfetch-cooldown.test.js "$DIR"/quota-knowledge.test.js "$DIR"/urlfetch-meter.test.js "$DIR"/parser-message.test.js "$DIR"/stay-stage.test.js; do
  echo "=== $(basename "$f") ==="
  out=$("$RUN" "$f"); echo "$out"
  echo "$out" | grep -q '0 FAIL' || fail=1
done
[ "$fail" = 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }

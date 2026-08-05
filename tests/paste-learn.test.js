// 순수 로직 검증 (jsc) — index.html 답변 학습 붙여넣기(2026-08-05)와 동일 구현.
// (a) 치우기 가로채기: 어떤 치우기에서 붙여넣기 창을 띄우는가
// (b) 밀린 목록 필터: 어떤 dismissed 건이 학습 대상인가

// ---- index.html 과 동일 구현 ----
function shouldOfferPaste(d, reason) {
  return !!(d && (reason == null || reason === 'manual-sent')
    && (d.status || 'pending') !== 'notice' && d.reply && !d.corpusPasted);
}
function isPasteBacklog(d) {
  return !!(d && d.status === 'dismissed'
    && (d.dismissReason === 'handled' || d.dismissReason === 'manual-sent')
    && d.reply && d.origMsg && !d.corpusPasted
    && d.origin !== 'notice' && d.origin !== 'notice-eta' && d.origin !== 'review');
}

var pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else fail++; print((c ? '  PASS ' : '  FAIL ') + n); }

print('[a] 치우기 가로채기');
var base = { status: 'pending', reply: 'draft', origMsg: 'q' };
ok('지난 문의(reason 없음) → 붙여넣기 제안', shouldOfferPaste(base, undefined) === true);
ok('발송함(manual-sent) → 붙여넣기 제안', shouldOfferPaste(base, 'manual-sent') === true);
ok('답불요(no-reply) → 제안 안 함(답이 없었음)', shouldOfferPaste(base, 'no-reply') === false);
ok('notice 카드 → 제안 안 함(답장 대상 아님)', shouldOfferPaste({ status: 'notice', reply: 'x' }, undefined) === false);
ok('AI 초안 없는 건 → 제안 안 함', shouldOfferPaste({ status: 'pending' }, undefined) === false);
ok('이미 학습된 건(corpusPasted) → 재제안 안 함', shouldOfferPaste({ status: 'pending', reply: 'x', corpusPasted: true }, undefined) === false);

print('[b] 밀린 목록 필터');
var dis = { status: 'dismissed', dismissReason: 'handled', reply: 'draft', origMsg: 'q' };
ok('지난 문의로 치운 건 → 목록 포함', isPasteBacklog(dis) === true);
ok('발송함으로 치운 건 → 목록 포함', isPasteBacklog(Object.assign({}, dis, { dismissReason: 'manual-sent' })) === true);
ok('답불요로 치운 건 → 제외', isPasteBacklog(Object.assign({}, dis, { dismissReason: 'no-reply' })) === false);
ok('함께 정리(group-resolved) → 제외', isPasteBacklog(Object.assign({}, dis, { dismissReason: 'group-resolved' })) === false);
ok('일괄 정리(reason 없음) → 제외', isPasteBacklog({ status: 'dismissed', reply: 'x', origMsg: 'q' }) === false);
ok('학습 완료(corpusPasted) → 제외', isPasteBacklog(Object.assign({}, dis, { corpusPasted: true })) === false);
ok('부킹 알림(origin:notice) → 제외', isPasteBacklog(Object.assign({}, dis, { origin: 'notice' })) === false);
ok('후기(origin:review) → 제외', isPasteBacklog(Object.assign({}, dis, { origin: 'review' })) === false);
ok('pending 상태 → 제외(대기 탭 몫)', isPasteBacklog(Object.assign({}, dis, { status: 'pending' })) === false);

print(pass + ' PASS / ' + fail + ' FAIL');

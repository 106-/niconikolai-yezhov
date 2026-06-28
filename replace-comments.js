// ニコニコ動画 コメント一括置換スクリプト
// 使い方: ニコニコの視聴ページで DevTools Console にペースト
//
// 動作原理:
//   1. #root の __reactContainer$ から React Fiber ツリーのルートを取得
//   2. BFS でフックを走査し、Immerストア (se) とプレイヤー (PN) を探す
//      - Jotai の useReducer は memoizedState = [atomValue, ...] の形で格納
//   3. ストアの update() で comments / filteredComments を書き換え
//      → subscribe チェーンが発火し za() → patchComments() まで自動実行
//   4. レンダラーの chatList も直接書き換えて refreshComments() で即時反映

(() => {
  const msg = 'このコメントは置換されました！';

  // ---- Step 1: #root の __reactContainer$ から Fiber root を取得 ----
  const rootEl = document.getElementById('root');
  if (!rootEl) return console.error('[replace] #root が見つかりません');
  const ck = Object.keys(rootEl).find(k => k.startsWith('__reactContainer$'));
  if (!ck) return console.error('[replace] __reactContainer$ が見つかりません');
  const root = rootEl[ck];

  // ---- Step 2: Fiber ツリーを BFS でストアとプレイヤーを探索 ----
  let store, player;
  const seen = new Set();
  const q = [root];

  while (q.length && !(store && player)) {
    const f = q.shift();
    if (!f || seen.has(f)) continue;
    seen.add(f);

    let h = f.memoizedState;
    for (let i = 0; h && i < 80; h = h.next, i++) {
      const check = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        try {
          // se ストア: update(), current(), subscribe() を持ち、current() が comments を含む
          if (!store
              && typeof obj.update === 'function'
              && typeof obj.current === 'function'
              && typeof obj.subscribe === 'function') {
            const s = obj.current();
            if (s?.comments && s?.filteredComments) store = obj;
          }
        } catch {}
        // PN プレイヤー: commentRenderer プロパティを持つ
        if (!player && obj.commentRenderer && typeof obj.commentRenderer === 'object') {
          player = obj;
        }
      };

      const v = h.memoizedState;
      check(v);
      if (v && typeof v === 'object') {
        check(v.current);
        if (Array.isArray(v)) v.forEach(item => check(item));
      }
      if (h.queue?.lastRenderedState) {
        const lrs = h.queue.lastRenderedState;
        check(lrs);
        if (Array.isArray(lrs)) lrs.forEach(item => check(item));
      }
      if (h.baseState && typeof h.baseState === 'object') {
        check(h.baseState);
        if (Array.isArray(h.baseState)) h.baseState.forEach(item => check(item));
      }
    }

    if (f.child) q.push(f.child);
    if (f.sibling) q.push(f.sibling);
  }

  if (!store && !player) {
    return console.error('[replace] ストアもプレイヤーも見つかりません');
  }

  const renderer = player?.commentRenderer;

  // ---- Step 3: ストアを書き換え (今後表示されるコメントに反映) ----
  if (store) {
    store.update(draft => {
      for (const c of Object.values(draft.comments)) c.body = msg;
      if (draft.filteredComments) {
        for (const c of Object.values(draft.filteredComments)) c.body = msg;
      }
    });
    console.log(`[replace] ストア更新: ${Object.keys(store.current().comments).length} 件`);
  }

  // ---- Step 4: レンダラーの Chat オブジェクトも直接書き換え + 再描画 ----
  if (renderer) {
    renderer.layerProcessorList.forEach(layer => {
      layer.stagingChatManager.chatList.forEach(chat => {
        chat.content = msg;
      });
    });
    try {
      renderer.refreshCommentsByTarget(renderer.getContentTimeMs());
    } catch {
      try { renderer.draw(); } catch {}
    }
    console.log('[replace] レンダラー更新完了');
  }

  console.log(`[replace] 完了 (store=${!!store}, renderer=${!!renderer})`);
})();

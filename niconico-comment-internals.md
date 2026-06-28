# ニコニコ動画 コメントシステム内部構造

HAR ファイル `sm25839952.har` の解析に基づく。
対象プレイヤー: `nvpc_next` (resource.video.nimg.jp/web/scripts/nvpc_next/)

---

## 1. API: コメント取得

### エンドポイント

```
POST https://public.nvcomment.nicovideo.jp/v1/threads?pc=1
```

### リクエストヘッダ

`fetch()` ラッパー関数 `qi` が以下を付与:

| ヘッダ | 値 |
|---|---|
| `X-Frontend-Id` | 数値 (frontendId) |
| `X-Frontend-Version` | バージョン文字列 |
| `X-Client-Os-Type` | OS種別文字列 |

`credentials: "omit"`, `mode: "cors"`, `cache: "no-store"`

### リクエストボディ

```json
{
  "params": {
    "targets": [
      {"id": "1426934910", "fork": "owner"},
      {"id": "1426934910", "fork": "main"},
      {"id": "1426934910", "fork": "easy"}
    ],
    "language": "ja-jp"
  },
  "threadKey": "eyJ...(JWT)...",
  "additionals": {}
}
```

| フィールド | 説明 |
|---|---|
| `targets[].id` | スレッドID (動画ごとに固定) |
| `targets[].fork` | `owner` = 投稿者コメント, `main` = 通常コメント, `easy` = かんたんコメント |
| `threadKey` | JWT。視聴ページの初期データに含まれ、`watch.comment.nvComment.threadKey` から取得 |
| `additionals` | 過去ログ取得時に `{when: timestamp}` を含むことがある |

### レスポンス

```json
{
  "meta": {"status": 200},
  "data": {
    "globalComments": [{"id": "1426934910", "count": 9853}],
    "threads": [
      {
        "id": "1426934910",
        "fork": "owner",
        "commentCount": 0,
        "comments": []
      },
      {
        "id": "1426934910",
        "fork": "main",
        "commentCount": 9807,
        "comments": [
          {
            "id": "876697703447228466",
            "no": 51,
            "vposMs": 1871440,
            "body": "ピトー管とかあったな",
            "commands": ["184"],
            "userId": "hogehugafoobar1234567",
            "isPremium": true,
            "score": 0,
            "postedAt": "2015-03-21T21:12:10+09:00",
            "nicoruCount": 0,
            "nicoruId": null,
            "source": "leaf",
            "isMyPost": false
          }
        ]
      },
      {
        "id": "1426934910",
        "fork": "easy",
        "commentCount": 46,
        "comments": [...]
      }
    ],
    "voltageZone": {...}
  }
}
```

### コメントオブジェクトの各フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | コメント固有ID |
| `no` | number | スレッド内通番 |
| `vposMs` | number | 動画内の表示タイミング (ミリ秒) |
| `body` | string | コメント本文 |
| `commands` | string[] | 表示コマンド (`184`, `red`, `big`, `ue`, `shita` 等) |
| `userId` | string | ハッシュ化されたユーザーID |
| `isPremium` | boolean | プレミアム会員か |
| `score` | number | NGスコア (低いほどNG度が高い) |
| `postedAt` | string | 投稿日時 (ISO 8601) |
| `nicoruCount` | number | ニコられ数 |
| `nicoruId` | string\|null | 自分がニコったときのID |
| `source` | string | `leaf` = 過去ログ, `trunk` = 最新 |
| `isMyPost` | boolean | 自分のコメントか |

---

## 2. JS ファイル構成

HAR 内の主要 JS ファイル (nvpc_next/assets/ 配下):

| ファイル | サイズ | 役割 |
|---|---|---|
| `PlayerSeekBar-CGjsSKzy.js` | 1.4 MB | コメントストア、フィルター、PixiJSレンダラー、弾幕ロジック全体 |
| `PlayerCurrentTime-CujLdDzC.js` | 68 KB | Jotai アトム定義、プレイヤー初期化フロー |
| `entry.client-CMdsAvme.js` | 176 KB | エントリポイント |
| `_web.watch._id._-main-ieA8RhHP.js` | 66 KB | 視聴ページ固有ロジック |
| `react-DtebY7Fq.js` | 168 KB | React ランタイム |
| `enum-Bt0veLcQ.js` | 148 KB | 列挙型定義群 |

---

## 3. データフロー全体図

```
[1] fetch POST /v1/threads
     │
     ▼
[2] Ji() — fetch 実行、threadKey の自動リフレッシュ付き
     │
     ▼
[3] ha() — レスポンス加工 + ストア書き込み
     │  各コメントに $videoId, $threadId, $fork, $timestamp 等を付加
     │  store.update() で comments, threads, globalComments を一括セット
     │
     ▼
[4] Oi() — 非同期フィルターパイプライン
     │  NGワード、NGユーザー、NGスコア、削除済みコメント等を適用
     │  結果を filteredComments に格納
     │
     ▼
[5] store.subscribe() → Ua() セレクタ
     │  threads × filteredComments → レイヤーごとの表示コメント集合を計算
     │
     ▼
[6] za() — 差分計算
     │  前回と今回の filteredComments を比較し added/deleted/updated に分類
     │
     ▼
[7] commentRenderer.patchComments(patches)
     │  各 Xy (LayerProcessor) に差分を配布
     │
     ▼
[8] Xy.stagingChatManager — vposMs 順にソートして保持
     │
     ▼
[9] アニメーションループ (Iv: RAF / Lv: setInterval)
     │  毎フレーム: STAGE → UPDATE_POSITION → REMOVE → draw()
     │
     ▼
[10] PixiJS renderer.render(stage) — Canvas に描画
```

---

## 4. ストア (State Management)

### ストアクラス `se`

Immer ベースのカスタムイミュータブルストア。zustand/Redux/Jotai ではない独自実装。
Jotai アトム `R` の値として保持される。

```
ファクトリー: ae() → new se()
コメント用:   Qa() → ae() を呼び、{status: "empty"} で初期化

PlayerCurrentTime.js 内の Jotai アトム R:
  R = h(x(() => cn()), [...])   // cn = Qa
```

#### API

| メソッド | 説明 |
|---|---|
| `store.current()` | 現在の state を返す (読み取り専用) |
| `store.update(draft => {...})` | Immer の draft で state を変更。変更があれば subscribe に通知 |
| `store.subscribe(callback)` | state 変更時のコールバック登録。返り値は unsubscribe 関数 |
| `store.setup(initialState)` | 初期 state を設定 |
| `store.dispose()` | クリーンアップ |

#### 内部動作

```js
// se クラスの update メソッド (復元):
update(mutator) {
  if (this.draft) return mutator(this.draft);  // ネストした update 対応
  this.draft = immer.createDraft(this.state);
  mutator(this.draft);
  const next = immer.finishDraft(this.draft);
  this.draft = undefined;
  if (this.state !== next) {
    const prev = this.state;
    this.state = next;
    this.emit(next, prev);  // subscribe に通知
  }
}
```

### State の形状 (status: "fetched" 時)

```typescript
{
  status: "fetched",
  watch: {
    video: { id: string, count: { comment: number }, duration: number },
    comment: {
      nvComment: {
        server: string,      // "https://public.nvcomment.nicovideo.jp"
        threadKey: string,    // JWT
        params: {             // targets 配列
          targets: Array<{id: string, fork: string}>,
          language: string
        }
      },
      threads: Array<{
        id: number,
        forkLabel: string,    // "owner" | "main" | "easy"
        videoId: string,
        label: string,
        isDefaultPostTarget: boolean,
        isEasyCommentPostTarget: boolean,
        isThreadkeyRequired: boolean,
        hasNicoscript: boolean
      }>,
      ng: { viewer?: { items: Array, count: number } },
      layers: Array<{
        index: number,
        threadIds: Array<{id: number, forkLabel: string}>,
        isTranslucent: boolean
      }>
    },
    viewer: { isPremium: boolean },
    player: {
      layerMode: number,
      comment: { isDefaultInvisible: boolean }
    }
  },
  userNg: {
    count: number,
    revision: number,
    isEnabled: boolean,
    lastMatchedTimeMap: Record<string, Record<string, number>>
  },
  globalComments: Array<{id: string, count: number}>,
  threads: Array<{
    id: string,
    fork: string,
    commentCount: number,
    $commentIds: string[],      // このスレッドに属するコメントIDの配列
    $isVideoThread: boolean,
    $isDefaultPostTarget: boolean,
    $isThreadkeyRequired: boolean,
    $isEasyCommentPostTarget: boolean,
    $hasNicoscript: boolean
  }>,
  voltageZone: any,
  comments: Record<string, EnrichedComment>,       // 全コメント (ID → コメント)
  filteredComments: Record<string, EnrichedComment> | null,  // フィルター済みコメント
  filterCommentQueue: string[],     // フィルター待ちキュー
  isFiltering: boolean,
  isFilteredOnce: boolean,
  isPosting: boolean,
  isEasyPosting: boolean,
  isOwnerCommentModified: boolean,
  isEnableAtNumberForViewerComments: boolean,
  fetchAdditionals: { when?: number }
}
```

### EnrichedComment (ストア内のコメントオブジェクト)

API レスポンスのコメントに以下のフィールドが付加される:

```typescript
{
  // --- API 由来 ---
  id: string,
  no: number,
  vposMs: number,
  body: string,
  commands: string[],
  userId: string,
  isPremium: boolean,
  score: number,
  postedAt: string,
  nicoruCount: number,
  nicoruId: string | null,
  source: string,
  isMyPost: boolean,
  deleted?: any,

  // --- ha() が付加 ---
  $videoId: string,
  $threadId: string,
  $fork: string,           // "owner" | "main" | "easy"
  $timestamp: number,       // new Date(postedAt).getTime()
  $postedInWatch: boolean,  // この視聴セッション中に投稿されたか
  $original: {
    deleted: any
  }
}
```

---

## 5. フェッチ関数群

### Ji() / Yi() — コメントフェッチ本体

```
位置: PlayerSeekBar.js, byte offset ~42783
```

```js
// 復元コード:
async function Ji(server, videoId, params, additionals) {
  return await Gi(
    // Step 1: threadKey を取得 (キャッシュ有)
    async (forceRefresh) => await zi({videoId}, forceRefresh),
    // Step 2: POST /v1/threads
    (keyResponse) => qi('POST', `${server}/v1/threads`, {
      params: {
        params: params,
        threadKey: keyResponse.data.threadKey,
        additionals: additionals
      }
    })
  ).then(r => r.json());
}
```

### Gi() / Ki() — トークンリフレッシュラッパー

```
位置: PlayerSeekBar.js, byte offset ~42670
```

```js
// 復元コード:
async function Gi(getKey, makeRequest, forceRefresh = false) {
  const response = await makeRequest(await getKey(forceRefresh));
  if (200 <= response.status && response.status < 300) return response;
  const body = await response.json();
  if (!forceRefresh && body?.meta?.errorCode === 'EXPIRED_TOKEN') {
    return Gi(getKey, makeRequest, true);  // 1回だけリトライ
  }
  throw body;
}
```

### qi() — fetch ラッパー

```
位置: PlayerSeekBar.js, byte offset ~42820
```

```js
// 復元コード:
function qi(method, url, options) {
  const config = y.get();  // フロントエンド設定
  const u = new URL(url);
  if (options?.query) {
    Object.keys(options.query).forEach(k => u.searchParams.append(k, options.query[k]));
  }
  u.searchParams.append('pc', '1');
  return fetch(u.toString(), {
    method,
    headers: new Headers({
      'X-Frontend-Id': config.frontendId.toString(),
      'X-Frontend-Version': config.frontendVersion,
      'X-Client-Os-Type': config.clientOsType
    }),
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    body: options && 'params' in options ? JSON.stringify(options.params) : undefined
  });
}
```

### ThreadKey キャッシュ

```
Fi: Map — threadKey のキャッシュ
Ri(videoId, threadKey) — 初期値をキャッシュに投入 (視聴ページロード時)
zi({videoId}, forceRefresh) — キャッシュから取得 or API で再取得
```

---

## 6. ha() — レスポンス処理 + ストア書き込み

```
位置: PlayerSeekBar.js, byte offset ~48752
```

```js
// 復元コード:
async function ha(store, additionals = {}) {
  wn(store, ['initialized', 'fetched']);  // state チェック
  const state = store.current();

  // 1. フェッチ
  const response = await Ji(
    state.watch.comment.nvComment.server,
    state.watch.video.id,
    state.watch.comment.nvComment.params,
    additionals
  );

  // 2. レスポンスを加工
  const result = { threads: [], comments: {} };

  response.data.threads.forEach(apiThread => {
    // watch 設定のスレッド定義とマッチ
    const watchThread = state.watch.comment.threads.find(
      t => String(t.id) === apiThread.id && t.forkLabel === apiThread.fork
    );
    if (!watchThread) return;

    const comments = apiThread.comments;  // (htrzm モードでは cr() でマージ)
    const commentIds = [];

    comments.forEach(comment => {
      comment.$videoId = watchThread.videoId;
      comment.deleted = comment.deleted ?? undefined;
      comment.$threadId = apiThread.id;
      comment.$fork = apiThread.fork;
      comment.$timestamp = new Date(comment.postedAt).getTime();
      comment.$postedInWatch =
        (state.status === 'fetched' && state.comments[comment.id]?.$postedInWatch) ?? false;
      comment.$original = { deleted: comment.deleted };
      result.comments[comment.id] = comment;
      commentIds.push(comment.id);
    });

    result.threads.push({
      id: apiThread.id,
      fork: apiThread.fork,
      commentCount: apiThread.commentCount,
      $commentIds: commentIds,
      $isVideoThread: watchThread ? !/^extra-/.test(watchThread.label) : false,
      $isDefaultPostTarget: watchThread?.isDefaultPostTarget ?? false,
      $isThreadkeyRequired: watchThread?.isThreadkeyRequired ?? false,
      $isEasyCommentPostTarget: watchThread?.isEasyCommentPostTarget ?? false,
      $hasNicoscript: watchThread?.hasNicoscript ?? false
    });
  });

  // 3. ストアに書き込み
  store.update(draft => {
    Object.assign(draft, {
      status: 'fetched',
      globalComments: deepClone(response.data.globalComments),
      threads: deepClone(result.threads),
      voltageZone: deepClone(response.data.voltageZone),
      comments: deepClone(result.comments),
      filteredComments: draft.status === 'fetched' ? deepClone(draft.filteredComments) : null,
      filterCommentQueue: draft.status === 'fetched' ? deepClone(draft.filterCommentQueue) : [],
      isFiltering: false,
      isFilteredOnce: draft.status === 'fetched' ? draft.isFilteredOnce : false,
      isPosting: false,
      isEasyPosting: false,
      isOwnerCommentModified: false
    });
  });

  // 4. フィルタリング開始
  Oi(store);
}
```

---

## 7. Oi() — フィルターパイプライン

```
位置: PlayerSeekBar.js, byte offset ~38786
```

```js
// 復元コード:
function Oi(store) {
  const filterConfig = ai(store.current());  // フィルター設定を構築
  if (!filterConfig) return;

  store.update(draft => { draft.isFiltering = true });

  (async () => {
    await requestIdleCallback();  // ji() — ブラウザアイドル時に実行
    const result = await ki(filterConfig, store.current());

    store.update(draft => {
      Object.assign(draft, result.updatedState);
      draft.isFiltering = false;
      draft.isFilteredOnce = true;
      draft.filteredComments = deepClone(result.filteredComments);
    });

    // キューに溜まったコメントもフィルタリング
    if (store.current().filterCommentQueue.length > 0) {
      store.update(draft => {
        ui(draft, draft.filterCommentQueue);
        draft.filterCommentQueue = [];
      });
    }
  })();
}
```

### フィルターチェーン

| 関数 | 適用対象 | 説明 |
|---|---|---|
| `Qr` | owner スレッド | ニコスクリプト処理 |
| `Zr` | viewer スレッド | 複合フィルター (以下を順次適用) |
| `Pr()` | 全 | 削除済みコメント除外 |
| `Fr(threshold)` | 全 | NGスコアフィルター (`bi.high=-1000, middle=-4800, low=-10000`) |
| `Ir(ownerNgs)` | 全 | 投稿者NGフィルター |
| `Yr(userNg)` | 全 | ユーザーNGフィルター (ワード/ユーザーID) |
| `zr()` | 全 | ニコスクリプト `/replace` 適用 |
| `Mr(settings)` | 全 | 表示設定に基づくフィルター |

フィルターの結果は `{filteredComments: Record<id, comment>, updatedState: {...}}` の形式。
`filteredComments` に含まれるコメントだけが描画対象になる。

---

## 8. ストアからレンダラーへの接続

### Ua() — セレクタ

```
位置: PlayerSeekBar.js, byte offset ~59683
```

ストアの `threads` + `filteredComments` からレイヤーごとのコメント集合を計算する:

```js
// 復元コード:
const Ua = memoize(state => {
  if (state.status !== 'fetched') return {};
  return {
    status: state.status,
    layers: state.watch.comment.layers,
    threads: state.threads,
    filteredComments: state.filteredComments
  };
}, state => {
  if (state.status !== 'fetched') return [];
  return state.layers.map(layer => ({
    index: layer.index,
    kind: Ga({threadIds: layer.threadIds, threads: state.threads}),
    isTranslucent: layer.isTranslucent,
    filteredComments: Wa({ ...state, layer })
  })).sort((a, b) => b.index - a.index);
});
```

### Wa() — レイヤーごとのコメント振り分け

```js
// 復元コード:
function Wa(state) {
  if (!state.filteredComments) return {};
  const result = {};
  state.layer.threadIds.forEach(tid => {
    const thread = state.threads.find(
      t => String(t.id) === String(tid.id) && String(t.fork) === tid.forkLabel
    );
    if (!thread) return;
    thread.$commentIds.forEach(cid => {
      const comment = state.filteredComments?.[cid];
      if (comment) result[cid] = comment;
    });
  });
  return result;
}
```

### za() — 差分計算

```
位置: PlayerSeekBar.js, byte offset ~58497
```

```js
// 復元コード:
function za(prevLayers, nextLayers) {
  const allIndices = [];
  prevLayers.map(l => l.index).concat(nextLayers.map(l => l.index))
    .sort()
    .forEach(i => { if (!allIndices.includes(i)) allIndices.push(i) });

  return allIndices.map(index => ({
    index,
    ...Ba(
      prevLayers.find(l => l.index === index)?.filteredComments || {},
      nextLayers.find(l => l.index === index)?.filteredComments || {}
    )
  }));
}

function Ba(prev, next) {
  const added = [], deleted = [], updated = [];

  // prev にあって next にないもの → deleted
  Object.keys(prev).forEach(id => {
    if (!next[id] && prev[id]) deleted.push(prev[id]);
  });

  // next にあるもの → prev にもあれば更新チェック、なければ added
  Object.keys(next).forEach(id => {
    const n = next[id];
    if (!n) return;
    const p = prev[id];
    if (p) {
      if (!Va(p, n)) updated.push(n);  // 変更があれば updated
    } else {
      added.push(n);
    }
  });

  return { added, deleted, updated };
}

// 変更検出:
function Va(prev, next) {
  return prev.body === next.body
    && prev.vposMs === next.vposMs
    && prev.$postedInWatch === next.$postedInWatch
    && deepEqual(prev.commands, next.commands);
}
```

### initializeComments() — 接続の起点

```
位置: PlayerSeekBar.js, byte offset ~1357414
PlayerCurrentTime.js から呼ばれる:
  await r.initializeComments(e(R))  // e(R) = Jotai アトム R の値 = ストアインスタンス
```

```js
// 復元コード (PN クラスのメソッド):
async initializeComments(store, options) {
  const watch = this.watch;

  // ストアの subscribe を登録
  const onUpdate = (layerData, status) => {
    let layers = options?.isOwnerCommentsOnly
      ? layerData.filter(l => l.kind === 'owner')
      : layerData;

    if (options?.isAiCommentHidden) {
      layers = layers.map(l => ({
        ...l,
        filteredComments: Object.fromEntries(
          Object.entries(l.filteredComments).filter(([, c]) => c.$fork !== 'ai')
        )
      }));
    }

    // レイヤー数が変わったら再構築
    if (this.commentLayers.length !== layers.length) {
      this.commentLayers.forEach(l => this.commentRenderer.deleteLayer(l.index));
      layers.forEach(l => {
        this.commentRenderer.createLayer(l.index);
        // エフェクト設定 (半透明、AIコメントフィルター等)
      });
    }

    // 差分パッチを適用
    this.commentRenderer.patchComments(za(this.commentLayers, layers));
    this.commentLayers = layers;
  };

  // 初回実行 + subscribe
  onUpdate(Ua(store.current()), store.current().status);
  this.disposes.push(store.subscribe(memoize(Ua, data => {
    onUpdate(data, store.current().status);
  })));

  // ResizeObserver で画面リサイズ時にレンダラーを更新
  const resizeObserver = new ResizeObserver(debounce(() => {
    this.commentRenderer.onResizedParent();
  }, 200));
  resizeObserver.observe(this.stage);

  // コンテンツ長さを設定
  this.commentRenderer.contentLengthMs = this.media.getDuration() * 1000;

  // play/pause をレンダラーに伝播
  this.media.events.on('play', () => this.commentRenderer.play());
  this.media.events.on('pause', () => this.commentRenderer.pause());
}
```

---

## 9. レンダラー (PixiJS ベース)

### アーキテクチャ概要

```
Qy (CommentRenderer)
  ├── pixiRenderer: PixiJS Renderer (Canvas2D or WebGL)
  ├── stage: PixiJS Container (ルートステージ)
  ├── layerProcessorList: Xy[] (レイヤーごとの処理器)
  │     └── Xy (LayerProcessor)
  │           ├── stagingChatManager: _y (コメントキュー)
  │           │     └── chatList: U_[] (ソート済みコメント配列)
  │           ├── slotRepository: $v (表示スロットプール, 最大40)
  │           │     ├── reservedList: Zv[] (空きスロット)
  │           │     └── _stagingList: Zv[] (表示中スロット)
  │           ├── processor: Yy (テキスト → PixiJS Sprite 変換)
  │           └── layer: Qv (PixiJS DisplayObject)
  └── repeatSchedulers: (Iv | Lv)[] (アニメーションスケジューラー)
```

### Qy (CommentRenderer)

```
位置: PlayerSeekBar.js, byte offset ~629616
```

```js
// 復元コード (主要部分):
class Qy {
  constructor(parentElement, options = {}) {
    this.isShort = !!options.isShort;
    this.layerProcessorList = [];
    this._playing = false;
    this.slotCount = options.slotCount ?? 40;  // DEFAULT_SLOT_COUNT

    this.parentElement = typeof parentElement === 'string'
      ? document.querySelector(parentElement)
      : parentElement;

    this.updateCanvasSize();

    // PixiJS レンダラー生成
    const useWebGL = options.useWebGL ?? false;
    this.pixiRenderer = autoDetectRenderer({
      width: this._canvasWidth,
      height: this._canvasHeight,
      backgroundAlpha: 0,       // 透明背景
      antialias: true,
      preserveDrawingBuffer: useWebGL,
      forceCanvas: !useWebGL    // デフォルトは Canvas2D
    });

    this.parentElement.appendChild(this.pixiRenderer.view);
    this.fitCanvasToParent();

    this.stage = new Container();  // PixiJS ルートコンテナ
    this.resolution = options.resolution ?? 2;  // Retina 対応
    this._processUpdatingContentTime = options.processUpdatingContentTime ?? (() => 0);
    this.stagingCommentsIntervalMs = options.stagingCommentsIntervalMs ?? 'auto';
  }

  patchComments(patches) {
    if (!patches?.length) return;
    patches.forEach(patch => {
      const layer = this.layerProcessorList.find(l => l.layerId === patch.index);
      if (layer) {
        layer.patchComments(
          W_(patch.added),    // コメント → U_ (Chat) に変換
          W_(patch.deleted),
          W_(patch.updated)
        );
      }
    });
  }

  createLayer(id) {
    const layer = new Xy({
      layerId: id,
      width: this._canvasWidth,
      height: this._canvasHeight,
      slotCount: this.slotCount,
      contentLengthMs: this._contentLengthMs,
      resolution: this.pixiRenderer.resolution,
      fontFamiliesProvider: this.fontFamiliesProvider,
      isShort: this.isShort
    });
    this.layerProcessorList.push(layer);
    this.stage.addChild(layer.displayObject);
    // イベント接続 ...
  }

  play() { this._playing = true; }
  pause() { this._playing = false; }
  draw() { this.pixiRenderer.render(this.stage); }

  reserveRedraw() {
    if (this.redrawReserveId === null) {
      this.redrawReserveId = window.setTimeout(() => {
        this.draw();
        this.redrawReserveId = null;
      }, 0);
    }
  }

  getContentTimeMs() {
    return this._processUpdatingContentTime();  // = media.getCurrentTime() * 1000
  }
}
```

#### Canvas サイズ

```
内部高さ: 固定 384px (BASE_CANVAS_HEIGHT)
内部幅:   Math.ceil(384 / parentHeight * parentWidth)
基準サイズ: 4:3 → 512x384 (通常), 3:4 → 288x384 (ショート)

CSS: position:absolute, width:100%, height:100% (親要素にフィット)
```

#### インスタンスの生成箇所

```js
// PN クラスのコンストラクタ内 (byte offset ~1375884):
this.commentRenderer = new Qy(this.view.comment, {
  useWebGL: false,
  resolution: 2,
  processUpdatingContentTime: () => this.media.getCurrentTime() * 1000,
  isShort: !!config.isShort
});
```

### U_ (Chat) — コメント描画オブジェクト

```
位置: PlayerSeekBar.js, byte offset ~582984
```

```js
// 復元コード:
class U_ {
  constructor(comment) {
    this.comment = comment;  // 元の EnrichedComment
    this.id = comment.id;
    this.mail = comment.commands;
    this.content = comment.body;
    this.thread = comment.$threadId;
    this.fork = comment.$fork;
    this.vpos = Math.floor(comment.vposMs / 10);  // 10ms 単位に変換
    this.vposMs = comment.vposMs;
    this.userId = comment.userId;
    this.no = comment.no;
    this.isPremium = comment.isPremium;

    // commands をパース
    const parsed = Xn(comment.commands);
    this.commands = parsed.commands ?? [];
    this.position = parsed.position ?? 'naka';   // ue | naka | shita
    this.size = parsed.size ?? 'medium';          // big | medium | small
    this.colorName = parsed.colorName ?? 'white';
    this.colorCode = parsed.colorCode ?? COLOR_MAP[this.colorName];
    this.color = this.colorCode;
    this.font = parsed.font ?? 'defont';          // defont | gothic | mincho
    this.atNumber = parsed.atNumber;              // @N秒 指定

    if (comment.$postedInWatch) {
      this.setBorderLine(COLOR_MAP['yellow']);
    }
  }

  setContent(text) { this.content = text; }
  getOriginalContent() { return this.comment.body; }
  equals(other) { return this.id === other.id; }
}

function W_(comments) { return comments.map(c => new U_(c)); }
```

### アニメーションループ

```
位置: PlayerSeekBar.js, byte offset ~637869
```

#### スケジューラークラス

| クラス | 駆動方式 | 用途 |
|---|---|---|
| `Iv` | requestAnimationFrame | フレームごとの座標更新・描画 |
| `Lv` | setTimeout (インターバル) | コメント登場・退場の定期処理 |

#### 処理ステップ (Zy enum)

| 値 | 名前 | 説明 |
|---|---|---|
| 0 | `STAGE` | vposMs に達したコメントを画面に登場させる |
| 1 | `REMOVE` | 表示時間が終了したコメントを画面から除去 |
| 2 | `UPDATE_POSITION` | 流れるコメントのX座標を更新 |

```js
// 復元コード (setupUpdatingCommentsSchedule):
// AUTO モード: 1つの RAF スケジューラーで全ステップ処理
this.repeatSchedulers.push(new Iv(scheduler => {
  const currentTime = this.getContentTimeMs();
  if (!this._playing && currentTime === lastTime) {
    if (!drawnOnce) { drawnOnce = true; this.draw(); }
    return;
  }
  drawnOnce = false;

  if (lastTime <= currentTime) {
    // 順再生: draw → 次フレームで REMOVE + UPDATE_POSITION + STAGE
    this.draw();
    scheduler.create(() => {
      this.updateCommentsByTarget(currentTime, [REMOVE, UPDATE_POSITION, STAGE]);
    }, 0);
  } else {
    // 巻き戻し: 全コメントの位置をリフレッシュ
    this.refreshCommentsByTarget(currentTime);
  }
  lastTime = currentTime;
}));
```

### 弾幕の座標計算

#### X座標 (水平移動)

```
流れるコメント (naka):
  initialX = canvasWidth/2 + baseWidth/2           (右端の外)
  targetX  = canvasWidth/2 - baseWidth/2 - width   (左端の外)
  x = initialX + (targetX - initialX) * ((currentTime - vStartMs) / (vEndMs - vStartMs))

固定コメント (ue/shita):
  x = canvasWidth/2 - width/2                      (中央固定)
```

#### Y座標 (縦方向レーン)

衝突回避アルゴリズム:
1. `ue`/`naka` → 上端から下方向にスキャン
2. `shita` → 下端から上方向にスキャン
3. 既存スロットと垂直+水平方向で重なりチェック
4. 重なればずらす、どこにも入らなければランダム配置

#### 表示時間

```
通常動画: 3000ms (ry)
ショート動画: 4000ms (iy)

流れるコメント:
  vStagingMs = vposMs - 2000    (2秒前にステージング準備)
  vStartMs   = vposMs - 1000    (1秒前に表示開始)
  vEndMs     = vStartMs + 1000 + viewTime   (3〜4秒 + 1秒)
  vRemoveMs  = vEndMs + 1000    (1秒後に除去)

固定コメント (ue/shita):
  vStagingMs = vposMs
  vStartMs   = vposMs
  vEndMs     = vposMs + viewTime
  vRemoveMs  = vEndMs

@N コマンドで viewTime を N秒に上書き可能
```

### スロットプール ($v)

```
DEFAULT_SLOT_COUNT = 40

1レイヤーあたり最大40個のコメントが同時に画面上に存在できる。
```

### フォント・スタイル

#### フォントファミリー

| コマンド | font-family | font-weight |
|---|---|---|
| `defont` | sans-serif | 600 |
| `gothic` | sans-serif | 400 |
| `mincho` | serif | 400 |

#### フォントサイズ (通常動画, baseHeight=384px)

| サイズ | 文字サイズ LINE_COUNT | 実サイズ (px) |
|---|---|---|
| `big` | 7.8 | 384/7.8 ≈ 49.2 |
| `medium` | 11.3 | 384/11.3 ≈ 34.0 |
| `small` | 16.6 | 384/16.6 ≈ 23.1 |

実際の描画サイズには `× 0.8` のスケーリング (`qv`) が適用される。最小値は 10px。

#### カラーマップ

| コマンド | カラーコード | 備考 |
|---|---|---|
| `white` | #ffffff | デフォルト |
| `red` | #ff0000 | |
| `pink` | #ff8080 | |
| `orange` | #ffc000 | |
| `yellow` | #ffff00 | |
| `green` | #00ff00 | |
| `cyan` | #00ffff | |
| `blue` | #0000ff | |
| `purple` | #c000ff | |
| `black` | #000000 | |
| `white2` / `niconicowhite` | #cccc99 | プレミアム |
| `red2` / `truered` | #cc0033 | プレミアム |
| `orange2` / `passionorange` | #ff6600 | プレミアム |
| `yellow2` / `madyellow` | #999900 | プレミアム |
| `green2` / `elementalgreen` | #00cc66 | プレミアム |
| `blue2` / `marineblue` | #3399ff | プレミアム |
| `purple2` / `nobleviolet` | #6633cc | プレミアム |
| `pink2` | #ff33cc | プレミアム |
| `cyan2` | #00cccc | プレミアム |
| `black2` | #666666 | プレミアム |

Hex カラーコード (`#RRGGBB`) も commands に直接指定可能。

#### 影 (アウトライン)

PixiJS の `strokeThickness` で実装 (Canvas の shadowBlur ではない):

```
デフォルト:
  色: rgba(0,0,0, 0.4)   黒い文字以外
      rgba(255,255,255, 0.4)   黒い文字の場合
  太さ: 2.8px
  lineJoin: 'round'
```

#### 透明度

```
デフォルト: 1.0
_live コマンド: 0.5
レイヤー全体の透明度設定:
  none → opacity: 1.0
  low  → opacity: 0.6
  high → opacity: 0.4
```

---

## 10. DOM 構造

```html
<div style="container-type: size; ...">             <!-- PN.stage -->
  <div style="...">                                   <!-- PN.view.inner -->
    <div style="z-index: 1; ...">                     <!-- PN.view.content (動画) -->
      <video />
    </div>
    <div style="z-index: 2; pointer-events: none; ..."> <!-- PN.view.comment (弾幕) -->
      <canvas style="position: absolute; width: 100%; height: 100%; left: 0; top: 0;" />
    </div>
  </div>
</div>
```

---

## 11. Minified シンボル → 役割 対応表

### PlayerSeekBar.js

| シンボル | 役割 |
|---|---|
| `se` | Immer ベースストアクラス |
| `ae` | ストアファクトリー `(initialState?) => new se()` |
| `Qa` | コメントストアファクトリー (ae + 初期化 + subscribe) |
| `ha` | コメントフェッチ + ストア書き込み |
| `Ji` / `Yi` | POST /v1/threads 実行 |
| `qi` | fetch ラッパー |
| `Gi` / `Ki` | トークンリフレッシュ + リトライラッパー |
| `zi` | threadKey 取得 (キャッシュ付き) |
| `Fi` | threadKey キャッシュ (Map) |
| `Ri` | threadKey キャッシュ投入 |
| `Oi` | 非同期フィルターパイプライン起動 |
| `ki` / `Ai` | フィルターチェーン実行 |
| `Qr` | owner スレッド用フィルター |
| `Zr` | viewer スレッド用フィルター |
| `Ua` | ストア → レイヤーデータ セレクタ (memoized) |
| `Wa` | レイヤーごとのコメント振り分け |
| `za` | 前回/今回の差分計算 (added/deleted/updated) |
| `Ba` | 差分の内部実装 |
| `Va` | コメント変更検出 (body, vposMs, commands) |
| `PN` | プレイヤークラス (メインコントローラー) |
| `MN` | ビュークラス (DOM 構造管理) |
| `Qy` | CommentRenderer (PixiJS ベース) |
| `Xy` | LayerProcessor (1レイヤーの管理) |
| `_y` | StagingChatManager (コメントキュー) |
| `$v` | SlotRepository (表示スロットプール) |
| `Zv` | Slot (1つの弾幕の表示枠) |
| `U_` | Chat (描画用コメントオブジェクト) |
| `W_` | コメント配列 → Chat配列 変換 |
| `Yy` | テキスト → PixiJS Sprite 変換プロセッサー |
| `Qv` | Layer (PixiJS DisplayObject ラッパー) |
| `Iv` | RAF ベーススケジューラー |
| `Lv` | setTimeout ベーススケジューラー |
| `Zy` | 処理ステップ enum (STAGE=0, REMOVE=1, UPDATE_POSITION=2) |
| `Rv` | マルチレイヤーエフェクトコントロール |
| `DM` | RenderArea enum (full, bottom) |
| `OM` | LayerMode enum (default, bottomWide, bottomCinema) |
| `Ha` | LayerKind enum (owner, main, easy, other, ai) |
| `w` | deepClone (Immer の structuredClone 相当) |
| `re` | memoize ユーティリティ |
| `wn` | state.status アサーション |

### PlayerCurrentTime.js

| シンボル | 役割 |
|---|---|
| `R` | コメントストアの Jotai アトム |
| `cn` | = Qa (コメントストアファクトリー) |
| `Kt` | = va (ストア初期化: watch データ投入) |
| `en` | = ha (コメントフェッチ) |
| `ln` | = Za (WatchData クラス) |
| `x` | Jotai atom() |
| `h` | Jotai atom with effects |
| `Cr` | ストア → 派生 Jotai アトム 変換ユーティリティ |

---

## 12. 拡張機能開発のための介入ポイント

### A. fetch フック (レスポンス書き換え)

最もクリーンな方法。ストアに入る前にコメントを改変する。

```
介入地点: window.fetch
条件: URL に nvcomment.nicovideo.jp/v1/threads を含む
操作: Response.json() の data.threads[].comments を改変
```

### B. ストアの update() 呼び出し

フィルター後の filteredComments を直接改変する。subscribe チェーンが自動発火。

```
介入地点: store.update(draft => { draft.filteredComments[id].body = ... })
前提: store インスタンスへの参照が必要 (React Fiber 経由等)
注意: comments と filteredComments の両方を変更する必要がある
```

### C. patchComments フック

Qy.prototype.patchComments を上書きして patch.added の U_ オブジェクトを改変する。

```
介入地点: commentRenderer.patchComments()
操作: patch.added の各 Chat.content を書き換え
注意: 既に画面上にある弾幕には影響しない (refreshComments() も必要)
```

### D. ボタン駆動での書き換え

再生準備完了後にボタンで改変を適用する場合:

```
1. fetch フックでレスポンスを保存
2. ボタン押下時:
   a. 保存済みレスポンスを改変
   b. store.update() で filteredComments を上書き
   c. commentRenderer.refreshComments() で弾幕を再描画
   → subscribe チェーンが za() → patchComments() → 描画まで自動実行
```

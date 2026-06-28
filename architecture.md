# ニコニコライエジョフ・プロトタイプ — 設計・実装解説

このドキュメントは `niconico-comment-filter.user.js` の設計判断と実装詳細を、
コードを読まなくても再実装できるレベルで記述する。

---

## 1. 全体方針

### なぜユーザースクリプトか

- **Chrome 拡張機能案**: Manifest V3 では `content_scripts` の `world: "MAIN"` で注入するが、`chrome.storage` にアクセスするには ISOLATED world 側のブリッジスクリプトが必要で、ファイルが増える。また popup の設定画面は最大 800x600px に制限される。
- **ユーザースクリプト案**: 単一ファイルで完結。`@grant GM_setValue/GM_getValue` で永続化。設定画面はモーダルオーバーレイなので画面いっぱいに使える。`unsafeWindow` でページコンテキストに直接アクセスできる。

結論: 要件 (ボタン駆動 + 正規表現設定) にはユーザースクリプトで十分。

### なぜ fetch フックではなくボタン駆動か

fetch フック方式 (`window.fetch` をラップして API レスポンスを書き換える) はストアに入る前にクリーンに改変できるが、以下の理由でボタン駆動を選択:

1. ユーザーが任意のタイミングでフィルターを適用/解除したい
2. ルール変更後に再適用できる
3. fetch フックはタイミング制御が複雑 (コメント API が複数回呼ばれる場合がある)

ボタン駆動の場合は再生準備完了後にストアとレンダラーを直接書き換える。

---

## 2. React Fiber ツリーからの内部アクセス

### 起点の取得

```
document.getElementById('root') → __reactContainer$xxx キー → Fiber root
```

`__reactContainer$` で始まるプロパティ名はビルドごとにハッシュが変わるため、`Object.keys().find()` で動的に検索する。

**注意**: `__reactFiber$` (個別要素に付く) ではなく `__reactContainer$` (ルートに付く) を使う。`video` 要素から `__reactFiber$` で遡ると、Jotai アトムで保持されたストアに到達できないケースがあった (Fiber ツリーの分岐が異なるため)。

### BFS 走査

Fiber ノードの `child` / `sibling` を BFS で走査する。各ノードの `memoizedState` はフックの連結リストで、`.next` で辿れる (最大80ノードで打ち切り)。

各フックの値は以下の3箇所にある:

| 場所 | 説明 |
|---|---|
| `hook.memoizedState` | useState/useRef/useMemo の現在値 |
| `hook.queue.lastRenderedState` | useReducer の最後にレンダーされた state |
| `hook.baseState` | useReducer のベース state |

Jotai の `useReducer` は `memoizedState = [atomValue, ...]` の配列形式で格納するため、配列の各要素もチェックする。

### ストアの検出条件

```js
typeof obj.update === 'function'
  && typeof obj.current === 'function'
  && typeof obj.subscribe === 'function'
  && obj.current()?.comments
  && obj.current()?.filteredComments
```

`update`/`current`/`subscribe` の3メソッドは Immer ストア (クラス `se`) のシグネチャ。
`comments` と `filteredComments` がある state を持つストアがコメントストア。

### プレイヤーの検出条件

```js
obj.commentRenderer && typeof obj.commentRenderer === 'object'
```

`commentRenderer` プロパティを持つオブジェクトがプレイヤー (クラス `PN`)。

---

## 3. フィルター適用ロジック

フィルター適用は3段階で行う:

### Stage 1: ストアの `comments` を書き換え

`store.update(draft => {...})` で Immer の draft を操作。
`draft.comments` の各エントリの `body` を正規表現で置換。
`replacement` が空文字列のルールにマッチした場合は `filteredComments` から当該 ID を `delete`。

### Stage 2: ストアの `filteredComments` も書き換え

`filteredComments` は `comments` のサブセット (NGフィルター通過済み)。
描画パイプラインは `filteredComments` を参照するため、こちらも同様に書き換える必要がある。

### Stage 3: レンダラーの chatList を書き換え + 再描画

ストア更新だけでは画面上の既存弾幕は変わらない。
PixiJS レンダラーが保持する `chatList` (Chat オブジェクト) の `content` プロパティも直接書き換え、
`renderer.refreshCommentsByTarget(renderer.getContentTimeMs())` で再描画を強制する。

```
renderer.layerProcessorList     : Xy[] (レイヤーごとの処理器)
  └── .stagingChatManager       : _y (コメントキュー管理)
       └── .chatList            : U_[] (vposMs 順にソートされた Chat 配列)
            └── .content        : string (表示テキスト。これを書き換える)
```

### 正規表現の lastIndex リセット

`new RegExp(..., 'gi')` はステートフルなので、`.test()` や `.replace()` の後に必ず `lastIndex = 0` をリセットする。
これを忘れると偶数回目のマッチが失敗する。

### フィルター解除

MVP では解除 = ページリロードに委ねる。ストアの変更を巻き戻すには元のコメントデータを保持する必要があるが、現時点では不要。

---

## 4. ボタン注入

### 挿入位置の特定

プレイヤーコントロールバーの「コメントを非表示にする」ボタンを DOM から探す:

```js
document.querySelector(
  '[aria-label="コメントを非表示にする"], [aria-label="コメントを表示する"]'
)
```

ボタンは Tooltip コンポーネント内にラップされているため、`closest('[data-scope]')` で Tooltip のルート要素を取得し、その親がコントロールバーとなる。

### 挿入

```
controlBar.insertBefore(wrapDiv, tooltipRoot)
```

コントロールバー内の Tooltip ルートの直前に独自の `div` を挿入する。
この `div` 内にフィルターボタンと設定ボタンの2つを配置する。

### ボタンのスタイリング

隣接する既存ボタン (`<button>`) の `className` を取得して借用する。
ニコニコのプレイヤーは Panda CSS でクラス名を生成しており、クラスを借用すればサイズ・パディング・ホバー効果が自動的に合う。

### MutationObserver による再注入

SPA ナビゲーションやプレイヤーの再構築でボタンが消える場合に備え、
`MutationObserver` で `document.body` を監視し、ボタンが消えたら再注入する。

---

## 5. チャットモーダル

### 開き方

プレイヤーコントロールバーの漏斗アイコンをクリック。

### UI 構造

```
[Overlay] position:fixed, inset:0, z-index:999999
  └── [Modal] 480px, max-height:70vh, flex column
        ├── [Header] タイトル + × ボタン
        ├── [Tabs] チャット | 設定 | コスト
        ├── [Chat Panel] (default)
        │     ├── [Chat Log] flex column, scroll
        │     │     ├── [AI Icon + Bubble] アイコン付きアシスタント応答 (マークダウン対応)
        │     │     ├── [User Bubble] ユーザーメッセージ
        │     │     ├── [Suggest Buttons] [提案] ボタン (複数選択可)
        │     │     ├── [Exec Button] 「選択した N 件を実行」
        │     │     ├── [Status Bubble] スピナー付きステータス
        │     │     └── [Details] 粛清結果 (折りたたみ)
        │     ├── [Start Button] 「▶ コメント N 件を分析」
        │     └── [Input + Send] テキスト入力 + 送信ボタン
        ├── [Settings Panel]
        │     ├── Anthropic API キー入力
        │     ├── Gemini API キー入力
        │     ├── OpenAI API キー入力
        │     ├── モデル選択 (全プロバイダー統合ドロップダウン)
        │     └── 保存ボタン
        └── [Usage Panel]
              ├── 累計トークン / コスト (USD + 円換算)
              ├── 直近の利用履歴 (モデル名, 動画ID, トークン, コスト)
              └── リセットボタン
```

### 永続化

- API キー: プロバイダーごとに `GM_setValue` で個別保存 (`nicofilter_apikey_anthropic`, `nicofilter_apikey_gemini`, `nicofilter_apikey_openai`)
- モデル: `GM_setValue('nicofilter_model', modelId)`
- 利用履歴: `GM_setValue('nicofilter_usage', {...})` (最大200件)

### カラースキーム

ニコニコ動画のデザインシステム (Panda CSS) から抽出したダークモードのカラートークンを使用。
詳細は `niconico-design-tokens.md` を参照。

---

## 6. Tampermonkey 固有の考慮事項

### @grant とサンドボックス

`@grant GM_setValue` 等を指定すると Tampermonkey はスクリプトをサンドボックス内で実行する。
ページの `window` には `unsafeWindow` 経由でアクセスする必要がある。

ただしユーザースクリプトが作成する DOM 要素 (`document.createElement` 等) はそのままページに追加でき、
イベントリスナーも通常通り動作する。`unsafeWindow` が必要なのは:

- `document.getElementById('root')` のような DOM アクセス (Fiber 走査の起点)
- `location.reload()` (フィルター解除)

### @run-at document-idle

`document-idle` で実行開始するが、プレイヤーの初期化はさらに遅いため、
`MutationObserver` で「コメントを非表示にする」ボタンが出現するまで待つ。

---

## 7. 制限事項と将来の拡張

### 現在の制限

- フィルター解除はページリロードのみ (元データを保持していない)
- ミニファイされたシンボル名に依存 (プレイヤーのアップデートで変わりうる)
  - ただし検出はシグネチャベースなので、メソッド名が変わらなければ動く
- シーク時に新しく表示されるコメントは再フィルター必要
  - ストアレベルで書き換え済みなので、シーク後のコメントも置換済みの body で表示される
  - レンダラーの chatList は時刻ベースで部分的に再利用されるため、一部反映されないケースがありうる

### 将来の拡張候補

- **fetch フック併用**: API レスポンスを傍受してストア投入前に書き換え (よりクリーン)
- **リアルタイム適用**: store.subscribe でフィルターを自動再適用
- **インポート/エクスポート**: ルールセットの共有

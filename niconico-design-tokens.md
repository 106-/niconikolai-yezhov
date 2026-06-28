# ニコニコ動画 デザインシステム カラートークン

ニコニコ動画 (`nvpc_next` プレイヤー) で使用されている CSS デザイントークンの解析結果。
HAR ファイルから抽出した `root-BNxV8oKs.css` (177KB) に基づく。

CSS フレームワークは **Panda CSS** を使用しており、デザイントークンは CSS カスタムプロパティとして定義される。
JS 側では `monotone.L15`, `action.primaryAzure` のようなドット記法で参照され、
CSS 側では `var(--colors-monotone--l15)`, `var(--colors-action-primary-azure)` にマッピングされる。

ニコニコ動画はライトモードとダークモードに対応しており、セマンティックトークンは `[data-color-scheme="dark"]` 等の属性セレクタで切り替わる。以下ではライト/ダーク両方の値を記載する (2つの値がある場合、1行目=ライト、2行目=ダーク)。

---

## 1. ベースカラー (Monotone)

グレースケールの段階。L は Lightness (明度) で、L0=黒、L100=白。

| トークン | CSS 変数 | HEX |
|---|---|---|
| `monotone.L0` | `--colors-monotone--l0` | `#000` |
| `monotone.L5` | `--colors-monotone--l5` | `#0d0d0d` |
| `monotone.L10` | `--colors-monotone--l10` | `#1a1a1a` |
| `monotone.L15` | `--colors-monotone--l15` | `#252525` |
| `monotone.L20` | `--colors-monotone--l20` | `#333` |
| `monotone.L25` | `--colors-monotone--l25` | `#404040` |
| `monotone.L30` | `--colors-monotone--l30` | `#4d4d4d` |
| `monotone.L40` | `--colors-monotone--l40` | `#666` |
| `monotone.L50` | `--colors-monotone--l50` | `gray` |
| `monotone.L60` | `--colors-monotone--l60` | `#999` |
| `monotone.L70` | `--colors-monotone--l70` | `#b3b3b3` |
| `monotone.L80` | `--colors-monotone--l80` | `#ccc` |
| `monotone.L90` | `--colors-monotone--l90` | `#e6e6e6` |
| `monotone.L95` | `--colors-monotone--l95` | `#f2f2f2` |
| `monotone.L100` | `--colors-monotone--l100` | `#fff` |

---

## 2. 透過カラー

### Transparent Gray (ベース `#1a1a1a`)

| トークン | CSS 変数 | HEX (RGBA) |
|---|---|---|
| `transparentGray.A5` | `--colors-transparent-gray--a5` | `#1a1a1a0d` |
| `transparentGray.A10` | `--colors-transparent-gray--a10` | `#1a1a1a1a` |
| `transparentGray.A20` | `--colors-transparent-gray--a20` | `#1a1a1a33` |
| `transparentGray.A40` | `--colors-transparent-gray--a40` | `#1a1a1a66` |
| `transparentGray.A60` | `--colors-transparent-gray--a60` | `#1a1a1a99` |
| `transparentGray.A80` | `--colors-transparent-gray--a80` | `#1a1a1acc` |
| `transparentGray.A95` | `--colors-transparent-gray--a95` | `#1a1a1af2` |
| `transparentGray.A100` | `--colors-transparent-gray--a100` | `#1a1a1a` |

### Transparent White (ベース `#f2f2f2`)

| トークン | CSS 変数 | HEX (RGBA) |
|---|---|---|
| `transparentWhite.A5` | `--colors-transparent-white--a5` | `#f2f2f20d` |
| `transparentWhite.A10` | `--colors-transparent-white--a10` | `#f2f2f21a` |
| `transparentWhite.A20` | `--colors-transparent-white--a20` | `#f2f2f233` |
| `transparentWhite.A40` | `--colors-transparent-white--a40` | `#f2f2f266` |
| `transparentWhite.A60` | `--colors-transparent-white--a60` | `#f2f2f299` |
| `transparentWhite.A80` | `--colors-transparent-white--a80` | `#f2f2f2cc` |
| `transparentWhite.A95` | `--colors-transparent-white--a95` | `#f2f2f2f2` |
| `transparentWhite.A100` | `--colors-transparent-white--a100` | `#f2f2f2` |

---

## 3. ブランドカラー

### Azure (青系 — プライマリアクセント)

| トークン | HEX |
|---|---|
| `azure.L5` | `#030d17` |
| `azure.L10` | `#051a2e` |
| `azure.L15` | `#082645` |
| `azure.L20` | `#0a335c` |
| `azure.L25` | `#0d4073` |
| `azure.L30` | `#0f4d8a` |
| `azure.L40` | `#1466b8` |
| `azure.L50` | `#1a80e6` |
| `azure.L60` | `#4799eb` |
| `azure.L70` | `#75b3f0` |
| `azure.L80` | `#a3ccf5` |
| `azure.L90` | `#d1e6fa` |
| `azure.L95` | `#e8f2fc` |

### Lust (赤系)

| トークン | HEX |
|---|---|
| `lust.L25` | `#730d1a` |
| `lust.L40` | `#b81433` |
| `lust.L50` | `#e61a40` |
| `lust.L70` | `#f075a3` |
| `lust.L80` | `#f5a3c0` |

### Banana (黄系)

| トークン | HEX | 用途例 |
|---|---|---|
| `banana.L20` | — | 注意の背景色 |
| `banana.L50` | — | プレミアム表示 |
| `banana.L90` | — | 背景ハイライト |

### その他のカラーファミリー

Indigo, Grape, Rose, Berry, Pumpkin, Marigold, Mint, Aqua が同様の L5-L95 のスケールで定義されている。

---

## 4. セマンティックトークン

### Layer (背景・サーフェス)

| トークン | ライトモード | ダークモード | 用途 |
|---|---|---|---|
| `layer.background` | `monotone.L95` (#f2f2f2) | `monotone.L5` (#0d0d0d) | ページ背景 |
| `layer.surfaceHighEm` | `monotone.L100` (#fff) | `monotone.L15` (#252525) | カード・モーダル背景 |
| `layer.surfaceMediumEm` | `monotone.L95` (#f2f2f2) | `monotone.L20` (#333) | 入力欄・セカンダリ背景 |
| `layer.surfaceLowEm` | `monotone.L90` (#e6e6e6) | `monotone.L30` (#4d4d4d) | 区切り・非活性背景 |
| `layer.surfaceLowerEm` | `monotone.L80` (#ccc) | `monotone.L50` (gray) | 最低コントラスト背景 |
| `layer.surfaceAccentAzure` | `azure.L50` (#1a80e6) | `azure.L50` (#1a80e6) | アクセント背景 |
| `layer.contentOverlay` | `transparentGray.A80` | `transparentGray.A80` | オーバーレイ |
| `layer.surfaceOverlay` | `transparentGray.A80` | `transparentGray.A60` | 半透明オーバーレイ |

### Text on Layer (テキスト)

| トークン | ライトモード | ダークモード | 用途 |
|---|---|---|---|
| `textOnLayer.highEm` | `monotone.L10` (#1a1a1a) | `monotone.L95` (#f2f2f2) | 本文テキスト |
| `textOnLayer.mediumEm` | `transparentGray.A80` | `transparentWhite.A80` | サブテキスト |
| `textOnLayer.lowEm` | `transparentGray.A60` | `transparentWhite.A60` | 補助テキスト |
| `textOnLayer.lowerEm` | `transparentGray.A40` | `transparentWhite.A40` | 最低コントラストテキスト |
| `textOnLayer.accentAzure` | `azure.L50` | `azure.L50` | リンク・アクセント |
| `textOnLayer.accentLust` | `lust.L50` | `lust.L50` | エラー・警告 |
| `textOnLayer.premium` | `service.premium` (#d9a300) | 同左 | プレミアム表示 |

### Action (ボタン・インタラクティブ要素)

| トークン | ライトモード | ダークモード | 用途 |
|---|---|---|---|
| `action.primary` | `transparentGray.A95` | `transparentWhite.A95` | プライマリボタン |
| `action.primaryHover` | `transparentGray.A80` | `transparentWhite.A80` | プライマリホバー |
| `action.primaryAzure` | `azure.L50` (#1a80e6) | 同左 | Azure プライマリ |
| `action.primaryAzureHover` | `azure.L40` (#1466b8) | 同左 | Azure プライマリホバー |
| `action.base` | `transparentGray.A5` | `transparentWhite.A10` | セカンダリボタン |
| `action.baseHover` | `transparentGray.A10` | `transparentWhite.A20` | セカンダリホバー |
| `action.ghost` | `transparentGray.A10` | 同左 | ゴーストボタン |
| `action.ghostHover` | `transparentGray.A20` | 同左 | ゴーストホバー |
| `action.textOnPrimary` | `monotone.L95` | `monotone.L10` | プライマリ上のテキスト |
| `action.textOnPrimaryAzure` | `azure.L95` (#e8f2fc) | 同左 | Azure プライマリ上のテキスト |
| `action.textOnBase` | `monotone.L10` | `monotone.L95` | セカンダリ上のテキスト |

### Border

| トークン | ライトモード | ダークモード |
|---|---|---|
| `border.base` | `transparentGray.A10` | `transparentWhite.A10` |
| `border.highEm` | `transparentGray.A5` | `transparentWhite.A5` |
| `border.ghost` | — | `transparentWhite.A40` |

### Icon

| トークン | ライトモード | ダークモード | 用途 |
|---|---|---|---|
| `icon.base` | `monotone.L10` | `monotone.L95` | 通常アイコン |
| `icon.baseDisabled` | `monotone.L70` | `monotone.L40` | 無効アイコン |
| `icon.watchControllerBase` | — | `monotone.L80` (#ccc) | プレイヤーコントロール |
| `icon.watchControllerHover` | — | `monotone.L100` (#fff) | コントロールホバー |
| `icon.watchControllerDisabled` | — | `monotone.L40` (#666) | コントロール無効 |
| `icon.primaryAzure` | `azure.L50` | 同左 | Azure アクセント |

### Input Form

| トークン | ライトモード | ダークモード |
|---|---|---|
| `inputForm.background` | `transparentGray.A5` | `transparentWhite.A5` |
| `inputForm.inputText` | `monotone.L10` | `monotone.L95` |
| `inputForm.placeholder` | `monotone.L70` | `monotone.L30` |

### Tooltip

| トークン | ライトモード | ダークモード |
|---|---|---|
| `tooltip.background` | `monotone.L90` | `monotone.L20` |
| `tooltip.textOnBackground` | `monotone.L15` | `monotone.L95` |

### Tab

| トークン | ライトモード | ダークモード |
|---|---|---|
| `tab.base` | `transparentGray.A5` | `transparentWhite.A10` |
| `tab.baseActive` | `transparentGray.A80` | `transparentWhite.A95` |
| `tab.baseHover` | `transparentGray.A10` | `transparentWhite.A20` |
| `tab.textOnBase` | `monotone.L10` | `monotone.L95` |

---

## 5. サービスカラー

| トークン | HEX | 用途 |
|---|---|---|
| `serviceColor.premium` | `#d9a300` | プレミアム会員 |
| `serviceColor.premiumHover` | `#a87e00` | プレミアムホバー |
| `serviceColor.live` | `#f03` (#ff0033) | ニコ生 |
| `serviceColor.chYellow` | `#ffe248` | チャンネル |
| `serviceColor.nicoadGold` | `#dca000` | ニコニ広告(金) |
| `serviceColor.nicoadYellow` | `gold` | ニコニ広告(黄) |
| `serviceColor.nicoadSilver` | `#bec8c8` | ニコニ広告(銀) |
| `serviceColor.nicoadGray` | `#889c9c` | ニコニ広告(灰) |
| `serviceColor.paid` | `#ffe248` | 有料コンテンツ |
| `serviceColor.roomGreen` | `#25c73f` | 部屋 |

---

## 6. コメントリスト固有

| トークン | 用途 |
|---|---|
| `commentList.nicoruLv1` | ニコられ Lv1 |
| `commentList.nicoruLv2` | ニコられ Lv2 |
| `commentList.nicoruLv3` | ニコられ Lv3 |
| `commentList.nicoruLv4` | ニコられ Lv4 |

---

## 7. ユーザースクリプトでの使い方

ユーザースクリプトから CSS 変数を直接参照することも可能:

```js
// ページ上の CSS 変数を取得
const style = getComputedStyle(document.documentElement);
const bg = style.getPropertyValue('--colors-layer-surface-high-em');
```

ただし CSS 変数名が変わるリスクがあるため、本プロジェクトではハードコードした HEX 値を使用し、
対応するトークン名をコメントで記載している。

```js
const NC = {
  bg:       '#252525',  // monotone.L15 — layer.surfaceHighEm (dark)
  text:     '#f2f2f2',  // monotone.L95 — textOnLayer.highEm (dark)
  azure:    '#1a80e6',  // azure.L50 — action.primaryAzure
  // ...
};
```

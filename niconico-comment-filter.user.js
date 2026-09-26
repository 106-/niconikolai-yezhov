// ==UserScript==
// @name         ニコニコライエジョフ
// @namespace    https://github.com/106-
// @version      0.5.0
// @description  Anthropic / Gemini / OpenAI API（分類は TypeSafe Jev も選択可）でニコニコ動画のコメントをAIフィルターする
// @match        https://www.nicovideo.jp/watch/*
// @match        https://nicovideo.jp/watch/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      api.openai.com
// @connect      api.typesafe.ai
// @updateURL    https://github.com/106-/niconikolai-yezhov/raw/refs/heads/main/niconico-comment-filter.user.js
// @downloadURL  https://github.com/106-/niconikolai-yezhov/raw/refs/heads/main/niconico-comment-filter.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const MODEL_STORAGE = 'nicofilter_model';
  const CLASSIFIER_STORAGE = 'nicofilter_classifier'; // '' = チャットと同じモデル、'jev' = TypeSafe Jev
  const USAGE_STORAGE = 'nicofilter_usage';
  const DEFAULT_MODEL = 'gpt-6-luna';
  const DEFAULT_CLASSIFIER = 'jev';

  const PROVIDERS = {
    anthropic: { keyStorage: 'nicofilter_apikey_anthropic' },
    gemini:    { keyStorage: 'nicofilter_apikey_gemini' },
    openai:    { keyStorage: 'nicofilter_apikey_openai' },
    typesafe:  { keyStorage: 'nicofilter_apikey_typesafe' },
  };

  // 料金は 2026-09 時点の各社公式ページ（USD / 1M トークン、プロンプト 200k 以下の標準料金）。
  // API の癖はモデルごとのフラグで吸収する:
  //   noSampling     … temperature を送ると 400（Anthropic 5 世代）/ 非推奨（Gemini 3 は既定 1.0 推奨）
  //   alwaysThinking … 思考を切れず、tool_choice の強制が 400（Claude Opus 5.5）
  //   thinkingByDefault … 省略時に適応的思考が走る（Claude Sonnet 5 以降）。思考トークンも max_tokens に含まれる
  //   lowLatencyThinking … 分類時の Gemini 3 の thinkingLevel（thinkingBudget: 0 は Gemini 3 では使えない）
  const MODELS = [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5',   provider: 'anthropic', inputPer1M: 1.00,  outputPer1M: 5.00 },
    { id: 'claude-sonnet-5',  label: 'Sonnet 5',    provider: 'anthropic', inputPer1M: 2.00,  outputPer1M: 10.00, noSampling: true, thinkingByDefault: true },
    { id: 'claude-opus-5-5',  label: 'Opus 5.5',    provider: 'anthropic', inputPer1M: 4.00,  outputPer1M: 20.00, noSampling: true, thinkingByDefault: true, alwaysThinking: true },
    { id: 'gemini-3.5-flash-lite',  label: 'Gemini 3.5 Flash-Lite', provider: 'gemini', inputPer1M: 0.30, outputPer1M: 2.50, noSampling: true, lowLatencyThinking: 'MINIMAL' },
    // 3.8 Flash は 2026-12-31 までの導入価格。2027-01-01 から $1.50 / $7.50
    { id: 'gemini-3.8-flash',       label: 'Gemini 3.8 Flash',      provider: 'gemini', inputPer1M: 0.75, outputPer1M: 3.75, noSampling: true, lowLatencyThinking: 'MINIMAL' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro',        provider: 'gemini', inputPer1M: 2.00, outputPer1M: 12.00, noSampling: true, lowLatencyThinking: 'LOW' },
    { id: 'gpt-6-luna',  label: 'GPT-6 Luna',  provider: 'openai', inputPer1M: 0.10,  outputPer1M: 0.50 },
    { id: 'gpt-6-sol',   label: 'GPT-6 Sol',   provider: 'openai', inputPer1M: 2.00,  outputPer1M: 10.00 },
  ];

  // Jev は文章を生成できないため、チャット用の MODELS には入れず分類専用の選択肢にする。
  // 出力トークンは無料（入力のみ課金）
  const JEV_MODEL = { id: 'jev-1.13.0', label: 'Jev 1.13', provider: 'typesafe', inputPer1M: 0.042, outputPer1M: 0 };

  function getModelInfo(modelId) {
    return MODELS.find(m => m.id === modelId) || MODELS[0];
  }

  // ========== 設定管理 ==========

  function loadApiKey() {
    const provider = getModelInfo(loadModel()).provider;
    const key = GM_getValue(PROVIDERS[provider].keyStorage, '');
    if (!key && provider === 'anthropic') {
      const legacy = GM_getValue('nicofilter_apikey', '');
      if (legacy) {
        GM_setValue(PROVIDERS.anthropic.keyStorage, legacy);
        return legacy;
      }
    }
    return key;
  }

  function saveApiKeyFor(provider, key) {
    GM_setValue(PROVIDERS[provider].keyStorage, key);
  }

  function loadApiKeyFor(provider) {
    const key = GM_getValue(PROVIDERS[provider].keyStorage, '');
    if (!key && provider === 'anthropic') {
      const legacy = GM_getValue('nicofilter_apikey', '');
      if (legacy) {
        GM_setValue(PROVIDERS.anthropic.keyStorage, legacy);
        return legacy;
      }
    }
    return key;
  }


  function loadModel() {
    return GM_getValue(MODEL_STORAGE, DEFAULT_MODEL);
  }

  function saveModel(model) {
    GM_setValue(MODEL_STORAGE, model);
  }

  function loadClassifier() {
    return GM_getValue(CLASSIFIER_STORAGE, DEFAULT_CLASSIFIER);
  }


  function saveClassifier(classifier) {
    GM_setValue(CLASSIFIER_STORAGE, classifier);
  }

  function loadUsage() {
    return GM_getValue(USAGE_STORAGE, { totalInput: 0, totalOutput: 0, totalCostUSD: 0, history: [] });
  }

  function recordUsage(model, u) {
    const m = [...MODELS, JEV_MODEL].find(x => x.id === model) || MODELS[0];
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    // Anthropic のプロンプトキャッシュ: 書き込みは 1.25 倍、読み出しは 0.1 倍で課金される
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const inputTokens = input + cacheWrite + cacheRead;
    const costUSD = ((input + cacheWrite * 1.25 + cacheRead * 0.1) / 1e6) * m.inputPer1M + (output / 1e6) * m.outputPer1M;
    const usage = loadUsage();
    usage.totalInput += inputTokens;
    usage.totalOutput += output;
    usage.totalCostUSD += costUSD;
    const videoId = location.pathname.match(/watch\/([a-z]{2}\d+)/)?.[1] || '';
    usage.history.push({ date: new Date().toISOString(), model: m.label, videoId, inputTokens, outputTokens: output, costUSD });
    if (usage.history.length > 200) usage.history = usage.history.slice(-200);
    GM_setValue(USAGE_STORAGE, usage);
    return { inputTokens, outputTokens: output, costUSD };
  }

  // ========== Fiber 走査 ==========

  function findStoreAndPlayer() {
    const doc = unsafeWindow.document;
    const rootEl = doc.getElementById('root');
    if (!rootEl) return null;

    const ck = Object.keys(rootEl).find(k => k.startsWith('__reactContainer$'));
    if (!ck) return null;

    const root = rootEl[ck];
    let store = null;
    let player = null;
    const seen = new Set();
    const q = [root];

    while (q.length && !(store && player)) {
      const f = q.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);

      let h = f.memoizedState;
      for (let i = 0; h && i < 80; h = h.next, i++) {
        const chk = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          try {
            if (!store
                && typeof obj.update === 'function'
                && typeof obj.current === 'function'
                && typeof obj.subscribe === 'function') {
              const s = obj.current();
              if (s?.comments && s?.filteredComments) store = obj;
            }
          } catch {}
          if (!player && obj.commentRenderer && typeof obj.commentRenderer === 'object') {
            player = obj;
          }
        };

        const v = h.memoizedState;
        chk(v);
        if (v && typeof v === 'object') {
          chk(v.current);
          if (Array.isArray(v)) v.forEach(x => chk(x));
        }
        if (h.queue?.lastRenderedState) {
          const lrs = h.queue.lastRenderedState;
          chk(lrs);
          if (Array.isArray(lrs)) lrs.forEach(x => chk(x));
        }
        if (h.baseState && typeof h.baseState === 'object') {
          chk(h.baseState);
          if (Array.isArray(h.baseState)) h.baseState.forEach(x => chk(x));
        }
      }

      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }

    if (!store && !player) return null;
    return { store, player };
  }

  // ========== 動画メタデータ ==========

  function getVideoMetadata() {
    try {
      const raw = document.querySelector('meta[name="server-response"]')?.content;
      const response = raw ? JSON.parse(raw)?.data?.response : null;
      const title = response?.video?.title?.trim();
      const tags = response?.tag?.items?.map(item => item.name?.trim()).filter(Boolean);
      if (title) {
        return { title, tags: [...new Set(tags ?? [])] };
      }
    } catch (e) {
      console.warn('[nicofilter] 動画メタデータの解析に失敗', e);
    }
    const title = document.querySelector('meta[property="og:title"]')?.content?.trim()
      || document.title.replace(/\s*-\s*ニコニコ動画$/, '').trim();
    const tags = [...document.querySelectorAll('meta[property="og:video:tag"]')]
      .map(el => el.content.trim()).filter(Boolean);
    return { title, tags: [...new Set(tags)] };
  }

  // ========== Anthropic API ==========

  const TOOLS = [
    {
      name: 'hide_comments',
      description: '指定された番号のコメントを非表示にする。荒らし、不快、ネタバレなど非表示にすべきコメントの番号を指定する。',
      input_schema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '非表示にするコメント番号のリスト（例: ["12", "34"]）'
          }
        },
        required: ['ids']
      }
    },
    {
      name: 'replace_comments',
      description: '指定された番号のコメントの本文を書き換える。翻訳、検閲、修正などに使う。',
      input_schema: {
        type: 'object',
        properties: {
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'コメント番号（例: "12"）' },
                new_body: { type: 'string', description: '置換後の本文' }
              },
              required: ['id', 'new_body']
            },
            description: '置換対象のコメントリスト'
          }
        },
        required: ['replacements']
      }
    },
    {
      name: 'hide_user',
      description: '指定されたユーザータグのコメントをすべて非表示にする。特定ユーザーの荒らし行為など、ユーザー単位でまとめて粛清したい場合に使う。',
      input_schema: {
        type: 'object',
        properties: {
          user_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '非表示にするユーザータグのリスト（例: ["u3"]）'
          }
        },
        required: ['user_ids']
      }
    }
  ];

  // ========== AIフィルター分類 ==========

  const FILTER_CATEGORIES = [
    { key: 'discrimination', label: '差別・ヘイト' },
    { key: 'harassment',     label: '暴言・誹謗中傷' },
    { key: 'flamewar',       label: 'レスバ・対立煽り' },
    { key: 'spoiler',        label: 'ネタバレ' },
    { key: 'spam',           label: 'スパム・宣伝' },
  ];

  const CLASSIFY_CHUNK_SIZE = 200;
  const CLASSIFY_CONCURRENCY = 8;

  const CLASSIFY_TOOL = {
    name: 'classify_comments',
    description: '問題のあるコメントの番号をカテゴリ別に報告する。問題のないコメントは含めない。該当がないカテゴリは空配列にする。',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        discrimination: { type: 'array', items: { type: 'integer' }, description: '差別・ヘイトに該当するコメント番号' },
        harassment:     { type: 'array', items: { type: 'integer' }, description: '暴言・誹謗中傷に該当するコメント番号' },
        flamewar:       { type: 'array', items: { type: 'integer' }, description: 'レスバ・対立煽りに該当するコメント番号' },
        spoiler:        { type: 'array', items: { type: 'integer' }, description: 'ネタバレに該当するコメント番号' },
        spam:           { type: 'array', items: { type: 'integer' }, description: 'スパム・宣伝に該当するコメント番号' }
      },
      required: ['discrimination', 'harassment', 'flamewar', 'spoiler', 'spam']
    }
  };

  const FILTER_SYSTEM_PROMPT = `あなたはニコニコ動画のコメント分類器。動画情報とコメント一覧（各行「#番号<TAB>本文」）を受け取り、classify_comments ツールで問題のあるコメントの番号を報告する。

## 出力ルール
- 全コメントを1件ずつ読み、問題のあるコメントの番号だけをカテゴリ別に報告する。問題のないコメント（ok）は出力しない。
- 判断に迷ったら報告しない（ok 扱い）。明確に該当する場合のみ報告する。
- 複数カテゴリに該当する場合は discrimination > harassment > flamewar > spoiler > spam の優先順で1つだけに入れる。
- 説明文は書かない。ツールコールだけを行う。

## ニコニコ文化の保護（常に ok とするもの）
- 弾幕・お約束コメント（「！？」「だろうな」「草」「8888」「wwww」など、シリーズ固有の定型ネタを含む）
- 空耳・ネタコメント・コメントアート
- 動画の内容への通常の感想・考察・突っ込み（「機長無能すぎる」のような内容への批判も ok）
- 動画の主題に関わる文化・国民性・組織体質の議論は、蔑称や属性への侮辱的一般化を含まない限り、批判的な内容でも ok

## 判定の考え方
「何について言っているか」で切り分ける。動画で扱われる事故・組織・文化的背景そのものへの言及は、辛辣でも ok。
「その属性を持つ人間全体」への蔑称・侮辱・デマ、および「他の視聴者」への攻撃が非表示の対象。
同じ単語（国名・民族名）を含んでいても、この区別で判定が変わることに注意する。

## カテゴリ定義と判定例

### discrimination — 差別・ヘイト
民族・国籍・人種・性別など属性への蔑称、属性全体への侮辱的一般化、属性を標的にしたデマ。
非表示にする例:
- 「だって韓国人だもの」（事故原因を民族性に帰す侮辱的一般化）
- 「この人種はプロ意識なんて皆無だからなｗ見栄をはって終わりｗ」
- 「計器の中からキムチが出てきました」（民族揶揄のネタ化）
- 「チョンは引継ぎしない、チョン産ネトゲみてりゃ分かるね」（蔑称＋一般化）
- 「結論：韓国はクソ」（国・民族全体への侮辱）
- 「流石韓国人ホントに期待を裏切らないなw」（属性への揶揄的一般化）
- 「大韓航空が出てくる度にこうやって在日ヒトモドキの皆さんが暴れるのか……」（蔑称＋レッテル貼り）
- 「本場キムチを食うと脳味噌を食う寄生虫に寄生されるのを、知ってるか？」（属性を標的にした侮蔑的デマ）
- 蔑称（「チョン」「ヒトモドキ」「土人」「ジャップ」等）を含むもの全般
ok とする例（境界）:
- 「韓国と日本の上下関係は異常だよな　「上は全て正しい」」→ ok（動画主題である文化的要因の議論）
- 「民族、国民の感情も航空事故調査には密接な関係がある」→ ok（冷静な考察）
- 「韓国の航空会社の話なんだからコメに韓国が溢れるのは当然では？」→ ok（冷静なメタ言及）
- 「悪質機長は別に韓国には限らないわな」→ ok（一般化への反論）
- 「儒教圏（中国・北朝鮮・韓国）」→ ok（事実の言及）

### harassment — 暴言・誹謗中傷
特定の人物への強い罵倒・中傷（「死ね」「ゴミカス」等の強い暴言、執拗な攻撃）。
ok とする例（境界）: 「機長無能すぎる」「バカねぇ…」のような動画内容への軽い突っ込み → ok

### flamewar — レスバ・対立煽り
他の視聴者コメントへの攻撃、コメント欄での論争の応酬、政治的レッテル貼り。
非表示にする例:
- 「↓黙れ朝鮮人」
- 「↑やっぱり朝鮮人ってバカなんだな、お前のことだぞ」
- 「お前の目は節穴か？」（他コメントへの攻撃）
- 「韓国批判＝右翼というバカ　…とか頭大丈夫か？」（レッテル貼り＋攻撃）
- 「↑他の国の航空会社ではこんなに出てこねえよ、お前らの言う韓国人とやってること変わらねえじゃん」（応酬の継続）
- 「動画を見れば韓国が馬鹿だって事が分かる。コメを見れば日本人が馬鹿だって事が分かる。」（コメント欄全体への煽り）
ok とする例（境界）:
- 「↑」「↓」で他コメントに冷静に反論・補足するもの → ok
- 「韓国関連でなぜか荒れているから。」→ ok（状況の説明）

### spoiler — ネタバレ
動画内でまだ明かされていない結末・犯人・原因を具体的に先バラしするもの。
非表示にする例: 序盤の時点で「この事故の原因は◯◯」「犯人は◯◯」と結末を明かすもの
ok とする例（境界）:
- シリーズ定番の予告的・様式的コメント（「メーデー民ならここでもう「は！？」ってなるやつ」等）→ ok
- その時点で動画内に既出の情報への言及 → ok

### spam — スパム・宣伝
動画と無関係な宣伝・誘導・チャンネル誘導、意味のない文字列の連投。
ok とする例（境界）: 「回転！」「FND!」「真水につけろ」「8888」のような弾幕・シリーズお約束の繰り返しは spam ではなく ok`;

  // ========== TypeSafe Jev（分類専用） ==========
  // ルーブリックを state に1回だけ置き、民族揶揄の隠語辞書を添える構成。
  // Jev は字面どおりに読むので、LLM なら文化知識で拾える隠語を辞書で補う。
  // 英語が主言語なので定義は英語、判定例は日本語の実コメントのまま渡す

  // 1リクエストは state + 全質問で 64k トークンが上限（超えると max_tokens_exceeded の 400）。
  // 件数ではなく推定トークンで詰める。推定は実測に対し ±9% 以内なので 55k なら上限に届かない
  const JEV_TOKEN_BUDGET = 55000;
  const JEV_MAX_PER_CHUNK = 255;
  // 3883 件（29 チャンク）で並列 8 / 16 / 32 = 2.8 / 1.6 / 1.2 秒、いずれも 429 なし。
  // レート制限は予告なく変わる（公式）ので、上限に寄せすぎない 16 にする。429 は callJev が再試行する
  const JEV_CONCURRENCY = 16;
  const JEV_THRESHOLD = 0.5;      // 1 - P(ok) がこれ以上なら問題ありと判定する

  const JEV_RUBRIC = {
    ok: {
      what: 'Normal viewer comments: reactions, impressions, analysis, jokes, danmaku / meme chants, soramimi, comment art, '
        + 'and blunt criticism of the people, organization or culture that the video itself is about.',
      not_for: 'Slurs, insulting generalizations about a whole ethnicity/nationality, or attacks on other viewers.',
      examples: ['機長無能すぎる', '韓国と日本の上下関係は異常だよな　「上は全て正しい」', '8888'],
    },
    discrimination: {
      what: 'Slurs against an ethnicity, nationality, race or gender; insulting generalizations about everyone with that attribute; '
        + 'jokes or hoaxes that mock an ethnic group.',
      not_for: 'Calm discussion of cultural or organizational factors that the video treats as a cause (e.g. cockpit hierarchy). '
        + 'Mentioning a country name alone is not discrimination.',
      examples: ['だって韓国人だもの', 'チョンは引継ぎしない、チョン産ネトゲみてりゃ分かるね'],
      known_mockery_vocabulary: {
        note: 'Japanese internet slang used to mock Koreans, Chinese and other groups. A comment that uses these to ridicule '
          + 'the group (not to discuss it) is discrimination, even when phrased as a joke or a meme parody.',
        terms: {
          'チョン / チョンコ / 朝鮮人 used as an insult / ウンコク / 南朝鮮 / ヒトモドキ / 土人 / 支那 / ジャップ': 'ethnic slurs',
          'キムチ / ヤンニョム / トンスル (+「〜に漬けろ」)': 'Korean food or "feces liquor" used as an ethnic joke; parodies of the series meme 「真水につけろ」',
          '火病 (ファビョる)': 'stereotype that Koreans are pathologically hot-tempered',
          'ニダ / ニカ / ウリ / ウリナラ / (｀∀´) / <丶｀∀´>': 'mock imitation of Korean speech; the 「ニダー」 caricature',
          'ケンチャナヨ (主義 / 精神)': 'stereotype that Koreans are sloppy and ignore safety',
          '半万年の歴史 / 属国 / 事大主義 / 建国してない': 'mockery of Korean history and sovereignty',
          'さすが韓国 / いつもの韓国 / これが韓国だ / 韓国だから / 彼の国': 'sarcasm attributing a failure to the whole nationality',
          '特ア / 特定アジア': 'derogatory grouping of China and the Koreas',
        },
      },
    },
    harassment: {
      what: 'Strong abuse or defamation aimed at a specific person (the uploader, a named person, a creator): "die", "trash", relentless attacks.',
      not_for: 'Light tsukkomi about what happens in the video, e.g. calling the pilot incompetent.',
      examples: ['うp主死ね'],
    },
    flamewar: {
      what: 'Attacking other viewers or their comments (often with ↑ / ↓), continuing a comment-section argument, political labeling, '
        + 'or provoking the whole comment section.',
      not_for: 'Calm replies or additions to another comment; describing that the comments are heated.',
      examples: ['↓黙れ朝鮮人', 'お前の目は節穴か？'],
    },
    spoiler: {
      what: 'Revealing the ending, culprit or root cause concretely before the video reveals it.',
      not_for: 'Ritual series-style foreshadowing comments; mentioning information the video already showed.',
      examples: ['先に言っとくと原因は姿勢指示器の故障を機長が無視したこと'],
    },
    spam: {
      what: 'Advertising or channel promotion unrelated to the video, links luring viewers elsewhere, meaningless repeated strings.',
      not_for: 'Danmaku and series in-jokes repeated by many viewers (e.g. 8888, 回転！, FND!).',
      examples: ['チャンネル登録よろしく！ youtube.com/@xxxx'],
    },
  };

  // Choice の選択肢は ok + FILTER_CATEGORIES のキー。境界の詳細は state.rubric を参照させる
  const JEV_CRITERIA = Object.fromEntries(Object.entries(JEV_RUBRIC).map(([k, v]) => [k, v.what]));

  function buildJevRequest(comments, meta) {
    const state = {
      context: 'Comment stream of a niconico video (Japanese). Comments are sorted by playback time. '
        + 'Nearby comments are context for each judgment.',
      video: { title: meta.title, tags: meta.tags },
      rubric: JEV_RUBRIC,
      comments: comments.map(jevCommentEntry),
    };
    const questions = {};
    for (const c of comments) questions[`c${c.index}`] = jevQuestion(c);
    return { model: JEV_MODEL.id, state, questions };
  }

  function jevCommentEntry(c) {
    const sec = Math.floor((c.vposMs ?? 0) / 1000);
    return { n: c.index, t: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, text: c.body };
  }

  function jevQuestion(c) {
    // 対象コメントの本文は instructions に直接入れる（Jev は state 内の間接参照が苦手）
    return {
      type: 'choice',
      instructions: {
        target_comment: { n: c.index, text: c.body },
        question: 'Which category does `target_comment` belong to? Apply the boundaries and examples in `rubric`. '
          + 'Judge only the target comment; other comments are context.',
      },
      criteria: JEV_CRITERIA,
    };
  }

  // 文字種ごとの重み + 1問あたりの固定分でトークン数を推定する。
  // 係数は実 API の usage に最小二乗で合わせた値
  function estimateJevTokens(value, questions = 0) {
    const text = JSON.stringify(value);
    let ascii = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
    return ascii * 0.233 + (text.length - ascii) * 1.089 + questions * 76;
  }

  // 推定トークンが JEV_TOKEN_BUDGET に収まるようにコメントを詰めてチャンクに分ける
  function chunkForJev(comments, meta) {
    const base = estimateJevTokens(buildJevRequest([], meta));
    const chunks = [];
    let current = [];
    let used = base;
    for (const c of comments) {
      const cost = estimateJevTokens(jevCommentEntry(c)) + estimateJevTokens(jevQuestion(c), 1);
      if (current.length > 0 && (used + cost > JEV_TOKEN_BUDGET || current.length >= JEV_MAX_PER_CHUNK)) {
        chunks.push(current);
        current = [];
        used = base;
      }
      current.push(c);
      used += cost;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  // Chrome の Tampermonkey 5.3+ は GM_xmlhttpRequest を全リクエスト直列に処理する（MV3 の制約。
  // https://github.com/Tampermonkey/tampermonkey/issues/2215 、ブラウザで 29 本が 0.76 秒おきに1本ずつ完了した）。
  // redirect を明示すると直列化の対象から外れるが、同じ URL 同士は待たされうるので、
  // 無視されるクエリで URL をリクエストごとに変える（公式の回避策 @require と同じ考え方）
  let jevRequestSeq = 0;

  function callJev(apiKey, body, attempt = 0) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://api.typesafe.ai/v1/systemone?r=${++jevRequestSeq}`,
        redirect: 'manual', // API はリダイレクトしないので追跡不要
        headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
        data: JSON.stringify(body),
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('レスポンスのパースに失敗: ' + e.message));
            }
            return;
          }
          // レート制限（1,200 RPM）と一時障害はバックオフして再試行する
          if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            const retryAfter = Number(res.responseHeaders?.match(/retry-after:\s*(\d+)/i)?.[1]);
            const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
            setTimeout(() => callJev(apiKey, body, attempt + 1).then(resolve, reject), waitMs);
            return;
          }
          let detail = res.responseText;
          try { detail = JSON.parse(res.responseText).error?.message || detail; } catch {}
          reject(new Error(`TypeSafe API エラー (${res.status}): ${detail}`));
        },
        onerror(err) {
          reject(new Error('ネットワークエラー: ' + (err.statusText || 'unknown')));
        }
      });
    });
  }

  // P(ok) 以外の合計がしきい値以上なら、ok 以外で最も確率の高いカテゴリを返す
  function decideJevCategory(probabilities) {
    if (!probabilities) return null;
    if (1 - (probabilities.ok ?? 0) < JEV_THRESHOLD) return null;
    return FILTER_CATEGORIES
      .map(fc => fc.key)
      .reduce((best, k) => ((probabilities[k] ?? 0) > (probabilities[best] ?? 0) ? k : best));
  }

  function callAnthropic(apiKey, messages, tools, system, opts = {}) {
    const model = loadModel();
    const info = getModelInfo(model);
    // 思考するモデルは思考トークンも max_tokens に数えられるので、返答が途中で切れないよう底上げする
    const maxTokens = opts.maxTokens ?? 4096;
    const body = { model, max_tokens: info.thinkingByDefault ? Math.max(maxTokens, 16000) : maxTokens, messages };
    if (tools) body.tools = tools;
    // Opus 5.5 は tool_choice の強制が 400 になるので、auto にしてシステムプロンプトで呼び出しを指示する
    const forceByPrompt = opts.toolChoice && info.alwaysThinking;
    if (forceByPrompt) system = `${system}\n\n必ず ${opts.toolChoice} ツールを1回だけ呼び出して回答すること。`;
    if (system) {
      // cacheSystem: ツール定義+システムプロンプト（安定プレフィックス）をキャッシュする。
      // 最低キャッシュ長はモデル依存（Haiku 4.5 は 4096 トークンで、現状のプレフィックスでは届かない）
      body.system = opts.cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    // cacheConversation: 最後のキャッシュ可能ブロックに自動配置（会話履歴全体をキャッシュ）
    if (opts.cacheConversation) body.cache_control = { type: 'ephemeral' };
    if (opts.toolChoice) {
      body.tool_choice = forceByPrompt ? { type: 'auto' } : { type: 'tool', name: opts.toolChoice };
    }
    // 分類の決定性向上用。5 世代は temperature を受け付けない（400）
    if (opts.temperature !== undefined && !info.noSampling) body.temperature = opts.temperature;
    if (opts.lowLatency && info.thinkingByDefault) {
      // Sonnet 5 は思考を切って強制ツール呼び出しで高速に分類する。思考を切れないモデルは effort で浅くする
      if (info.alwaysThinking) body.output_config = { effort: 'low' };
      else body.thinking = { type: 'disabled' };
    }
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // ブラウザ発（Origin ヘッダー付き）のリクエストに Anthropic が要求するオプトイン。
      // API キーがクライアント側にあることを了解した上での利用（本スクリプトの前提どおり）
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    };
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers,
        data: JSON.stringify(body),
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            let json;
            try {
              json = JSON.parse(res.responseText);
            } catch (e) {
              reject(new Error('レスポンスのパースに失敗: ' + e.message));
              return;
            }
            // 安全分類器による拒否は HTTP 200 で返る（content が空になりうる）
            if (json.stop_reason === 'refusal') {
              reject(new Error(`モデルが応答を拒否しました（${json.stop_details?.category ?? '理由不明'}）`));
              return;
            }
            resolve(json);
          } else {
            let detail = res.responseText;
            try { detail = JSON.parse(res.responseText).error?.message || detail; } catch {}
            reject(new Error(`API エラー (${res.status}): ${detail}`));
          }
        },
        onerror(err) {
          reject(new Error('ネットワークエラー: ' + (err.statusText || 'unknown')));
        }
      });
    });
  }

  function convertMessagesForGemini(messages) {
    const contents = [];
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const toolResultParts = [];
        const otherParts = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            otherParts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            otherParts.push({ functionCall: { name: block.name, args: block.input } });
          } else if (block.type === 'tool_result') {
            toolResultParts.push({
              functionResponse: {
                name: block.name || block.tool_use_id,
                response: { result: typeof block.content === 'string' ? block.content : 'done' }
              }
            });
          }
        }
        if (otherParts.length > 0) contents.push({ role, parts: otherParts });
        if (toolResultParts.length > 0) contents.push({ role: 'user', parts: toolResultParts });
      }
    }
    return contents;
  }

  function stripUnsupportedSchemaKeys(schema) {
    if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys);
    if (schema && typeof schema === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(schema)) {
        if (k === 'additionalProperties') continue;
        out[k] = stripUnsupportedSchemaKeys(v);
      }
      return out;
    }
    return schema;
  }

  function convertToolsForGemini(tools) {
    if (!tools || tools.length === 0) return undefined;
    return [{ functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: stripUnsupportedSchemaKeys(t.input_schema)
    })) }];
  }

  function normalizeGeminiResponse(raw) {
    const parts = raw.candidates?.[0]?.content?.parts || [];
    const content = parts.map(part => {
      if (part.text != null) return { type: 'text', text: part.text };
      if (part.functionCall) return {
        type: 'tool_use',
        id: 'gemini_' + Math.random().toString(36).slice(2, 10),
        name: part.functionCall.name,
        input: part.functionCall.args
      };
      return null;
    }).filter(Boolean);
    const meta = raw.usageMetadata || {};
    return {
      content,
      usage: {
        input_tokens: meta.promptTokenCount || 0,
        output_tokens: meta.candidatesTokenCount || 0
      }
    };
  }

  function callGemini(apiKey, messages, tools, system, opts = {}) {
    const model = loadModel();
    const info = getModelInfo(model);
    const contents = convertMessagesForGemini(messages);
    const body = { contents };
    const geminiTools = convertToolsForGemini(tools);
    if (geminiTools) body.tools = geminiTools;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (opts.toolChoice) {
      body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [opts.toolChoice] } };
    }
    const generationConfig = {};
    // Gemini 3 は temperature を既定の 1.0 から下げるとループや性能劣化を招くため送らない
    if (opts.temperature !== undefined && !info.noSampling) generationConfig.temperature = opts.temperature;
    if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens;
    // 分類は思考を最小にして高速化（Gemini 3 は完全オフ不可。Pro は LOW が下限）
    if (opts.lowLatency && info.lowLatencyThinking) {
      generationConfig.thinkingConfig = { thinkingLevel: info.lowLatencyThinking };
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify(body),
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(normalizeGeminiResponse(JSON.parse(res.responseText)));
            } catch (e) {
              reject(new Error('レスポンスのパースに失敗: ' + e.message));
            }
          } else {
            let detail = res.responseText;
            try { detail = JSON.parse(res.responseText).error?.message || detail; } catch {}
            reject(new Error(`API エラー (${res.status}): ${detail}`));
          }
        },
        onerror(err) {
          reject(new Error('ネットワークエラー: ' + (err.statusText || 'unknown')));
        }
      });
    });
  }

  function convertMessagesForOpenAI(messages, system) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) }
            });
          } else if (block.type === 'tool_result') {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : 'done'
            });
          }
        }
        if (msg.role === 'assistant') {
          const m = { role: 'assistant' };
          if (textParts.length > 0) m.content = textParts.join('\n');
          if (toolCalls.length > 0) m.tool_calls = toolCalls;
          out.push(m);
        } else if (textParts.length > 0) {
          out.push({ role: msg.role, content: textParts.join('\n') });
        }
        for (const tr of toolResults) out.push(tr);
      }
    }
    return out;
  }

  function convertToolsForOpenAI(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => {
      const fn = { name: t.name, description: t.description, parameters: t.input_schema };
      if (t.strict === true) fn.strict = true;
      return { type: 'function', function: fn };
    });
  }

  function normalizeOpenAIResponse(raw) {
    const choice = raw.choices?.[0]?.message || {};
    const content = [];
    if (choice.content) content.push({ type: 'text', text: choice.content });
    if (choice.tool_calls) {
      for (const tc of choice.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: args
        });
      }
    }
    const u = raw.usage || {};
    return {
      content,
      usage: {
        input_tokens: u.prompt_tokens || 0,
        output_tokens: u.completion_tokens || 0
      }
    };
  }

  function callOpenAI(apiKey, messages, tools, system, opts = {}) {
    const model = loadModel();
    const oaiMessages = convertMessagesForOpenAI(messages, system);
    const body = { model, messages: oaiMessages };
    const oaiTools = convertToolsForOpenAI(tools);
    if (oaiTools) body.tools = oaiTools;
    if (opts.toolChoice) body.tool_choice = { type: 'function', function: { name: opts.toolChoice } };
    if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
    // GPT-6 は temperature を送らない。Chat Completions で関数呼び出しを使えるのは
    // reasoning_effort が none のときだけなので、ツール付きの呼び出し（分類・チャット）は none にする
    if (oaiTools) body.reasoning_effort = 'none';
    else if (opts.lowLatency) body.reasoning_effort = 'low';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        data: JSON.stringify(body),
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(normalizeOpenAIResponse(JSON.parse(res.responseText)));
            } catch (e) {
              reject(new Error('レスポンスのパースに失敗: ' + e.message));
            }
          } else {
            let detail = res.responseText;
            try { detail = JSON.parse(res.responseText).error?.message || detail; } catch {}
            reject(new Error(`API エラー (${res.status}): ${detail}`));
          }
        },
        onerror(err) {
          reject(new Error('ネットワークエラー: ' + (err.statusText || 'unknown')));
        }
      });
    });
  }

  function callLLM(messages, tools, system, opts = {}) {
    const modelInfo = getModelInfo(loadModel());
    const apiKey = loadApiKey();
    if (modelInfo.provider === 'gemini') {
      return callGemini(apiKey, messages, tools, system, opts);
    }
    if (modelInfo.provider === 'openai') {
      return callOpenAI(apiKey, messages, tools, system, opts);
    }
    return callAnthropic(apiKey, messages, tools, system, opts);
  }

  // ========== ツール実行 ==========

  function executeHideComments(rawIds, store, player) {
    const ids = (Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? [rawIds] : Object.values(rawIds ?? {}).flat()).map(String);
    const idSet = new Set(ids);
    let count = 0;

    if (store) {
      store.update(draft => {
        if (draft.filteredComments) {
          for (const id of ids) {
            if (draft.filteredComments[id]) {
              delete draft.filteredComments[id];
              count++;
            }
          }
        }
      });
    }

    const renderer = player?.commentRenderer;
    if (renderer) {
      renderer.layerProcessorList.forEach(layer => {
        layer.stagingChatManager.chatList.forEach(chat => {
          if (idSet.has(chat.id)) {
            chat.content = '';
          }
        });
      });
    }

    return count;
  }

  function executeReplaceComments(replacements, store, player) {
    const replaceMap = new Map(replacements.map(r => [String(r.id), r.new_body]));
    let count = 0;

    if (store) {
      store.update(draft => {
        for (const [id, newBody] of replaceMap) {
          if (draft.comments[id]) {
            draft.comments[id].body = newBody;
            count++;
          }
          if (draft.filteredComments?.[id]) {
            draft.filteredComments[id].body = newBody;
          }
        }
      });
    }

    const renderer = player?.commentRenderer;
    if (renderer) {
      renderer.layerProcessorList.forEach(layer => {
        layer.stagingChatManager.chatList.forEach(chat => {
          const newBody = replaceMap.get(chat.id);
          if (newBody !== undefined) {
            chat.content = newBody;
          }
        });
      });
    }

    return count;
  }

  function executeHideUser(rawUserIds, store, player) {
    const userIds = new Set(
      (Array.isArray(rawUserIds) ? rawUserIds : typeof rawUserIds === 'string' ? [rawUserIds] : Object.values(rawUserIds ?? {}).flat()).map(String)
    );
    const hiddenIds = [];

    if (store) {
      const state = store.current();
      const targetCommentIds = [];
      for (const [key, c] of Object.entries(state.comments)) {
        if (userIds.has(String(c.userId || ''))) {
          targetCommentIds.push(String(c.id ?? key));
        }
      }
      executeHideComments(targetCommentIds, store, player);
      hiddenIds.push(...targetCommentIds);
    }

    return hiddenIds;
  }

  function executeToolCalls(toolCalls, store, player) {
    const hiddenIds = [];
    const replacedIds = [];
    let hideCommentCount = 0;
    let replaceCommentCount = 0;
    let hideUserCalls = 0;
    let hideUserCount = 0;
    let hideUserCommentCount = 0;
    for (const tc of toolCalls) {
      const input = tc.input;
      switch (tc.name) {
        case 'hide_comments': {
          const ids = (Array.isArray(input.ids) ? input.ids : typeof input.ids === 'string' ? [input.ids] : Object.values(input.ids ?? {}).flat()).map(String);
          executeHideComments(ids, store, player);
          hiddenIds.push(...ids);
          hideCommentCount += ids.length;
        }
          break;
        case 'replace_comments': {
          const repls = (Array.isArray(input.replacements) ? input.replacements : Object.values(input.replacements ?? {})).map(r => ({ ...r, id: String(r.id) }));
          executeReplaceComments(repls, store, player);
          replacedIds.push(...repls.map(r => r.id));
          replaceCommentCount += repls.length;
        }
          break;
        case 'hide_user': {
          const uids = (Array.isArray(input.user_ids) ? input.user_ids : typeof input.user_ids === 'string' ? [input.user_ids] : Object.values(input.user_ids ?? {}).flat()).map(String);
          const ids = executeHideUser(uids, store, player);
          hiddenIds.push(...ids);
          hideUserCalls++;
          hideUserCount += uids.length;
          hideUserCommentCount += ids.length;
        }
          break;
      }
    }

    const renderer = player?.commentRenderer;
    if (renderer) {
      try {
        renderer.refreshCommentsByTarget(renderer.getContentTimeMs());
      } catch {
        try { renderer.draw(); } catch {}
      }
    }

    return { hiddenIds, replacedIds, hideCommentCount, replaceCommentCount, hideUserCalls, hideUserCount, hideUserCommentCount };
  }

  // ========== セッション永続化 ==========
  // 動画IDごとに対話ログ・分類判定・非表示履歴を保存する。
  // コメントの連番・実IDは訪問ごとに変わるため、永続キーは「本文」を使う
  // （重複排除がもともと本文ベースなのでそのまま噛み合う）

  const SESSION_INDEX_STORAGE = 'nicofilter_session_index';
  const SESSION_PREFIX = 'nicofilter_session_';
  const SESSION_MAX_VIDEOS = 10;

  function currentVideoId() {
    return location.pathname.match(/watch\/([a-z]{0,2}\d+)/)?.[1] || '';
  }

  function loadSession(videoId) {
    if (!videoId) return null;
    return GM_getValue(SESSION_PREFIX + videoId, null);
  }

  function saveSessionData(videoId, data) {
    if (!videoId) return;
    GM_setValue(SESSION_PREFIX + videoId, data);
    let index = GM_getValue(SESSION_INDEX_STORAGE, []);
    index = index.filter(v => v !== videoId);
    index.push(videoId);
    // 古い動画のセッションから間引く（会話履歴はコメント一覧を含み大きいため）
    while (index.length > SESSION_MAX_VIDEOS) {
      GM_deleteValue(SESSION_PREFIX + index.shift());
    }
    GM_setValue(SESSION_INDEX_STORAGE, index);
  }

  function clearSession(videoId) {
    if (!videoId) return;
    GM_deleteValue(SESSION_PREFIX + videoId);
    const index = GM_getValue(SESSION_INDEX_STORAGE, []).filter(v => v !== videoId);
    GM_setValue(SESSION_INDEX_STORAGE, index);
  }

  // 保存済みの非表示・書き換えを現在のストアに適用する（本文キーなので冪等）
  function applyStoredFilters(session, store, player) {
    if (!session || !store) return 0;
    const hiddenSet = new Set(session.hiddenBodies || []);
    const replaced = session.replaced || {};
    const state = store.current();
    const hideIds = [];
    const repls = [];
    for (const [key, c] of Object.entries(state.comments)) {
      const id = String(c.id ?? key);
      if (hiddenSet.has(c.body)) hideIds.push(id);
      else if (replaced[c.body] !== undefined) repls.push({ id, new_body: replaced[c.body] });
    }
    const calls = [];
    if (hideIds.length > 0) calls.push({ name: 'hide_comments', input: { ids: hideIds } });
    if (repls.length > 0) calls.push({ name: 'replace_comments', input: { replacements: repls } });
    if (calls.length > 0) executeToolCalls(calls, store, player);
    return hideIds.length + repls.length;
  }

  // ページを開いた時点で前回のフィルターを自動再適用する。
  // コメントは逐次ロードされるため時間を空けて数回試行する（冪等なので重複適用は無害）
  let lastAutoAppliedVideoId = null;
  function scheduleAutoApply() {
    const videoId = currentVideoId();
    if (!videoId || lastAutoAppliedVideoId === videoId) return;
    lastAutoAppliedVideoId = videoId;
    const session = loadSession(videoId);
    if (!session) return;
    const hasFilters = (session.hiddenBodies || []).length > 0 || Object.keys(session.replaced || {}).length > 0;
    if (!hasFilters) return;
    [3000, 8000, 15000, 30000].forEach(delay => {
      setTimeout(() => {
        if (currentVideoId() !== videoId) return;
        const result = findStoreAndPlayer();
        if (result?.store) applyStoredFilters(session, result.store, result.player);
      }, delay);
    });
  }


  const NC = {
    bg:          '#252525',
    bgMedium:    '#333',
    text:        '#f2f2f2',
    textMedium:  '#f2f2f2cc',
    textLow:     '#f2f2f299',
    border:      '#f2f2f21a',
    overlay:     '#1a1a1acc',
    azure:       '#1a80e6',
    azureHover:  '#1466b8',
    azureText:   '#e8f2fc',
    actionBase:  '#f2f2f21a',
    actionHover: '#f2f2f233',
    ctrlBase:    '#ccc',
    ctrlHover:   '#fff',
  };

  // ========== チャットモーダル ==========

  const CHAT_SYSTEM_PROMPT = `あなたはニコニコ動画のコメント欄の治安を守る人民委員「ニコニコライエジョフ」。
語尾は「〜のだ」「〜なのだ」。ニコニコ動画の文化・ネット文化を理解しつつも、不適切なコメントには毅然と対処する。

## 初回応答

初回メッセージには AIフィルターの分類結果サマリーとコメント一覧が含まれる。以下の形式で応答する:

1. 天気予報形式の治安評価（1行目）。分類結果の件数と全体に占める割合を根拠にする:
   - ☀️ 快晴 — 良好、フィルター不要
   - 🌤️ 晴れ時々曇り — 概ね良好、少し気になる程度
   - ☁️ 曇り — やや荒れ、フィルター推奨
   - 🌧️ 雨 — 荒れている、フィルター強く推奨
   - ⛈️ 雷雨 — かなり荒れている、粛清必要

2. 評価コメント（2〜3文）

フィルター実行の提案ボタンは UI 側で別途表示されるため、提案の列挙は不要。

## 会話の継続

追加指示（「消して」「翻訳して」等）にはツールで対応する。ユーザーがフィルター指示を出したら、確認を求めずに即座にツールコールで粛清を実行する。「〜してよいか？」のような確認は不要。

## コメントデータの形式

各コメント行は「#番号  [時刻]  ユーザータグ  本文」のタブ区切り。
- ツールの ids にはコメント番号（例: "12"）を指定する
- hide_user の user_ids にはユーザータグ（例: "u3"）を指定する
- 同一ユーザータグが複数の問題コメントを投稿している場合は、hide_user でユーザー単位でまとめて粛清できる

## ニコニコ動画の文化を尊重する

以下はニコニコ動画の文化的コメントであり、フィルター対象にしない:
- 弾幕（同じ文字・絵文字の大量投稿、例: 🍩🍩🍩、888888、wwwwwwww）
- 空耳コメント、ネタコメント、定番のお約束コメント
- コメントアート（AAや記号で構成された装飾コメント）
これらはニコニコ動画の視聴体験の一部であり、荒らしではない。

## 重要

- 実際の操作はツールコールで行う
- 対象コメントの原文を列挙しない。件数と操作結果だけ報告する`;

  function openChatModal(store, player) {
    if (document.getElementById('nicofilter-chat')) return;

    const state = store.current();
    const commentMap = {};
    const bodyToIds = new Map();
    for (const [key, c] of Object.entries(state.comments)) {
      const id = String(c.id ?? key);
      const entry = { body: c.body, vposMs: c.vposMs, userId: String(c.userId || '') };
      commentMap[id] = entry;
      if (key !== String(id)) commentMap[key] = entry;
      const existing = bodyToIds.get(c.body);
      if (existing) existing.push(id);
      else bodyToIds.set(c.body, [id]);
    }

    function formatVpos(ms) {
      const s = Math.floor((ms ?? 0) / 1000);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      return `${m}:${String(ss).padStart(2, '0')}`;
    }

    const uniqueComments = [];
    for (const [body, ids] of bodyToIds) {
      const entry = commentMap[ids[0]];
      uniqueComments.push({ id: ids[0], body, vposMs: entry?.vposMs ?? 0, userId: entry?.userId || '' });
    }
    uniqueComments.sort((a, b) => a.vposMs - b.vposMs);

    // 連番インデックスとユーザータグ。LLM には短いトークンだけを渡し、
    // JS 側で実IDへ復元する（長いIDの転記ミスによる「静かな失敗」を防ぐ）
    const indexToComment = new Map();
    const userIdToTag = new Map();
    const userTagToId = new Map();
    uniqueComments.forEach((c, i) => {
      c.index = i + 1;
      indexToComment.set(c.index, c);
      if (c.userId && !userIdToTag.has(c.userId)) {
        const tag = 'u' + (userIdToTag.size + 1);
        userIdToTag.set(c.userId, tag);
        userTagToId.set(tag, c.userId);
      }
      c.userTag = c.userId ? userIdToTag.get(c.userId) : '';
    });

    function formatCommentLine(c) {
      return `#${c.index}\t[${formatVpos(c.vposMs)}]\t${c.userTag}\t${c.body.replace(/\s*\n\s*/g, ' ')}`;
    }

    // 番号("12" / "#12")または実IDを実コメントIDに解決する。不明なら null
    function resolveCommentToken(token) {
      const t = String(token).trim().replace(/^#/, '');
      if (/^\d+$/.test(t)) {
        const c = indexToComment.get(Number(t));
        if (c) return c.id;
      }
      return commentMap[t] ? t : null;
    }

    function expandIds(rawIds) {
      const tokens = (Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? [rawIds] : Object.values(rawIds ?? {}).flat()).map(String);
      const expanded = [];
      let unresolved = 0;
      for (const token of tokens) {
        const id = resolveCommentToken(token);
        if (id === null) { unresolved++; continue; }
        const c = commentMap[id];
        const siblings = c ? bodyToIds.get(c.body) : null;
        if (siblings) expanded.push(...siblings);
        else expanded.push(id);
      }
      return { ids: [...new Set(expanded)], unresolved };
    }

    const conversationMessages = [];
    let isSending = false;

    // -- セッション永続化の状態 --
    const videoId = currentVideoId();
    const savedSession = loadSession(videoId);
    const transcript = [];          // UI再現用の軽量ログ [{role: 'user'|'assistant'|'status', text}]
    const verdictsByBody = {};      // 分類判定（本文 -> カテゴリ、問題判定のみ）
    const hiddenBodies = new Set(); // 非表示にした本文
    const replacedByBody = {};      // 書き換え（元本文 -> 新本文）

    function recordTranscript(role, text) {
      transcript.push({ role, text });
    }

    function persistSession() {
      if (!videoId) return;
      saveSessionData(videoId, {
        version: 1,
        updatedAt: new Date().toISOString(),
        conversation: conversationMessages,
        transcript,
        verdicts: verdictsByBody,
        hiddenBodies: [...hiddenBodies],
        replaced: replacedByBody,
      });
    }

    // -- UI --
    const overlay = document.createElement('div');
    overlay.id = 'nicofilter-chat';
    overlay.style.cssText = `position:fixed;inset:0;z-index:999999;background:${NC.overlay};display:flex;align-items:center;justify-content:center;font-family:sans-serif;`;

    const modal = document.createElement('div');
    modal.style.cssText = `background:${NC.bg};color:${NC.text};border-radius:8px;display:flex;flex-direction:column;width:560px;height:70vh;max-height:700px;border:1px solid ${NC.border};`;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid ${NC.border};flex-shrink:0;`;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:0;';
    const tabStyle = (active) => `background:none;border:none;color:${active ? NC.text : NC.textLow};font-size:14px;font-weight:${active ? 'bold' : 'normal'};cursor:pointer;padding:4px 12px;border-bottom:2px solid ${active ? NC.azure : 'transparent'};transition:all 0.15s;`;

    const chatTab = document.createElement('button');
    chatTab.textContent = 'チャット';
    chatTab.style.cssText = tabStyle(true);

    const settingsTab = document.createElement('button');
    settingsTab.textContent = '設定';
    settingsTab.style.cssText = tabStyle(false);

    const usageTab = document.createElement('button');
    usageTab.textContent = 'コスト';
    usageTab.style.cssText = tabStyle(false);

    tabBar.append(chatTab, settingsTab, usageTab);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `background:none;border:none;color:${NC.textMedium};font-size:20px;cursor:pointer;padding:0 4px;`;
    closeBtn.onmouseenter = () => { closeBtn.style.color = NC.text; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = NC.textMedium; };
    closeBtn.onclick = () => overlay.remove();

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'リセット';
    resetBtn.title = 'この動画の対話ログ・判定ログを削除';
    resetBtn.style.cssText = `background:none;border:1px solid ${NC.border};border-radius:4px;color:${NC.textLow};font-size:11px;cursor:pointer;padding:2px 8px;margin-right:10px;`;
    resetBtn.onmouseenter = () => { resetBtn.style.color = NC.text; };
    resetBtn.onmouseleave = () => { resetBtn.style.color = NC.textLow; };
    resetBtn.onclick = () => {
      if (!confirm('この動画の対話ログと判定ログを削除するのだ。\n（非表示にしたコメントを画面に戻すにはページを再読み込み）')) return;
      clearSession(videoId);
      overlay.remove();
      openChatModal(store, player);
    };

    const headerRight = document.createElement('div');
    headerRight.style.cssText = 'display:flex;align-items:center;';
    headerRight.append(resetBtn, closeBtn);
    header.append(tabBar, headerRight);

    // Chat panel
    const chatPanel = document.createElement('div');
    chatPanel.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;';

    const chatLog = document.createElement('div');
    chatLog.style.cssText = 'flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px;min-height:0;';

    const inputArea = document.createElement('div');
    inputArea.style.cssText = `display:flex;gap:8px;padding:12px 20px;border-top:1px solid ${NC.border};flex-shrink:0;`;

    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.placeholder = '指示を入力...';
    chatInput.style.cssText = `flex:1;background:${NC.bgMedium};border:1px solid ${NC.border};border-radius:4px;color:${NC.text};padding:8px 10px;font-size:14px;outline:none;`;

    const sendBtn = document.createElement('button');
    sendBtn.textContent = '送信';
    sendBtn.style.cssText = `background:${NC.azure};border:none;border-radius:4px;color:${NC.azureText};padding:8px 16px;cursor:pointer;font-size:14px;font-weight:bold;`;
    sendBtn.onmouseenter = () => { sendBtn.style.background = NC.azureHover; };
    sendBtn.onmouseleave = () => { sendBtn.style.background = NC.azure; };

    inputArea.append(chatInput, sendBtn);
    chatPanel.append(chatLog, inputArea);

    // Settings panel
    const settingsPanel = document.createElement('div');
    settingsPanel.style.cssText = 'flex:1;overflow-y:auto;padding:24px 20px;display:none;';

    const inputFieldStyle = `background:${NC.bgMedium};border:1px solid ${NC.border};border-radius:4px;color:${NC.text};padding:8px 10px;font-size:14px;outline:none;width:100%;box-sizing:border-box;`;
    const labelStyle = `display:block;font-size:12px;color:${NC.textLow};margin-bottom:6px;`;

    let editAnthropicKey = loadApiKeyFor('anthropic');
    let editGeminiKey = loadApiKeyFor('gemini');
    let editOpenaiKey = loadApiKeyFor('openai');
    let editTypesafeKey = loadApiKeyFor('typesafe');
    let editModel = loadModel();
    let editClassifier = loadClassifier();

    const providerNames = { anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };

    function makeKeySection(label, value, placeholder, onInput) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:16px;';
      const lbl = document.createElement('label');
      lbl.style.cssText = labelStyle;
      lbl.textContent = label;
      const input = document.createElement('input');
      input.type = 'password';
      input.value = value;
      input.placeholder = placeholder;
      input.style.cssText = inputFieldStyle;
      input.oninput = () => onInput(input.value);
      section.append(lbl, input);
      return section;
    }

    const anthropicKeySection = makeKeySection('Anthropic API キー', editAnthropicKey, 'sk-ant-...', v => { editAnthropicKey = v; });
    const geminiKeySection = makeKeySection('Gemini API キー', editGeminiKey, 'AIza...', v => { editGeminiKey = v; });
    const openaiKeySection = makeKeySection('OpenAI API キー', editOpenaiKey, 'sk-...', v => { editOpenaiKey = v; });
    const typesafeKeySection = makeKeySection('TypeSafe API キー（分類に Jev を使う場合）', editTypesafeKey, '', v => { editTypesafeKey = v; });

    const modelSection = document.createElement('div');
    modelSection.style.cssText = 'margin-bottom:20px;';
    const modelLabel = document.createElement('label');
    modelLabel.style.cssText = labelStyle;
    modelLabel.textContent = 'モデル';
    const modelSelect = document.createElement('select');
    modelSelect.style.cssText = inputFieldStyle + 'cursor:pointer;';
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label} (${providerNames[m.provider] || m.provider})`;
      if (m.id === editModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    modelSelect.onchange = () => { editModel = modelSelect.value; };
    modelSection.append(modelLabel, modelSelect);

    // 分類（コメント分析の最初の段階）だけ別モデルにできる。治安評価とチャットは上のモデルが担当する
    const classifierSection = document.createElement('div');
    classifierSection.style.cssText = 'margin-bottom:20px;';
    const classifierLabel = document.createElement('label');
    classifierLabel.style.cssText = labelStyle;
    classifierLabel.textContent = '分類モデル';
    const classifierSelect = document.createElement('select');
    classifierSelect.style.cssText = inputFieldStyle + 'cursor:pointer;';
    for (const [value, text] of [['', 'チャットと同じモデル'], ['jev', `${JEV_MODEL.label} (TypeSafe) — 高速・低コスト`]]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (value === editClassifier) opt.selected = true;
      classifierSelect.appendChild(opt);
    }
    classifierSelect.onchange = () => { editClassifier = classifierSelect.value; };
    classifierSection.append(classifierLabel, classifierSelect);

    const saveBtn2 = document.createElement('button');
    saveBtn2.textContent = '保存';
    saveBtn2.style.cssText = `background:${NC.azure};border:none;border-radius:4px;color:${NC.azureText};padding:8px 16px;cursor:pointer;font-size:14px;font-weight:bold;width:100%;`;
    saveBtn2.onmouseenter = () => { saveBtn2.style.background = NC.azureHover; };
    saveBtn2.onmouseleave = () => { saveBtn2.style.background = NC.azure; };
    saveBtn2.onclick = () => {
      saveApiKeyFor('anthropic', editAnthropicKey);
      saveApiKeyFor('gemini', editGeminiKey);
      saveApiKeyFor('openai', editOpenaiKey);
      saveApiKeyFor('typesafe', editTypesafeKey);
      saveModel(editModel);
      saveClassifier(editClassifier);
      saveBtn2.textContent = '保存しました';
      setTimeout(() => { saveBtn2.textContent = '保存'; }, 1500);
    };

    settingsPanel.append(anthropicKeySection, geminiKeySection, openaiKeySection, typesafeKeySection, modelSection, classifierSection, saveBtn2);

    // Usage panel
    const usagePanel = document.createElement('div');
    usagePanel.style.cssText = 'flex:1;overflow-y:auto;padding:24px 20px;display:none;';

    function renderUsagePanel() {
      const usage = loadUsage();
      const yenRate = 150;
      const totalYen = usage.totalCostUSD * yenRate;

      const rowStyle = `display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${NC.border};font-size:13px;`;
      const valStyle = `color:${NC.text};font-weight:bold;`;

      let html = `<h3 style="margin:0 0 16px;font-size:14px;color:${NC.text};">累計利用状況</h3>`;
      html += `<div style="${rowStyle}"><span style="color:${NC.textLow}">入力トークン</span><span style="${valStyle}">${usage.totalInput.toLocaleString()}</span></div>`;
      html += `<div style="${rowStyle}"><span style="color:${NC.textLow}">出力トークン</span><span style="${valStyle}">${usage.totalOutput.toLocaleString()}</span></div>`;
      html += `<div style="${rowStyle}"><span style="color:${NC.textLow}">累計コスト</span><span style="${valStyle}">$${usage.totalCostUSD.toFixed(4)} (≈ ¥${Math.round(totalYen).toLocaleString()})</span></div>`;
      html += `<div style="${rowStyle}border-bottom:none;"><span style="color:${NC.textLow}">API呼び出し回数</span><span style="${valStyle}">${usage.history.length}</span></div>`;

      if (usage.history.length > 0) {
        html += `<h3 style="margin:20px 0 12px;font-size:14px;color:${NC.text};">直近の利用</h3>`;
        html += `<div style="font-size:12px;">`;
        const recent = usage.history.slice(-20).reverse();
        for (const h of recent) {
          const date = new Date(h.date);
          const time = `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
          const yenCost = Math.round(h.costUSD * yenRate);
          const vid = h.videoId ? ` ${h.videoId}` : '';
          html += `<div style="${rowStyle}font-size:12px;"><span style="color:${NC.textLow}">${time} ${h.model}${vid}</span><span style="color:${NC.textMedium}">${h.inputTokens.toLocaleString()} in / ${h.outputTokens.toLocaleString()} out — $${h.costUSD.toFixed(4)} (≈¥${yenCost.toLocaleString()})</span></div>`;
        }
        html += `</div>`;
      }

      html += `<button id="nicofilter-reset-usage" style="margin-top:20px;background:${NC.actionBase};border:1px solid ${NC.border};border-radius:4px;color:${NC.textLow};padding:8px 16px;cursor:pointer;font-size:12px;width:100%;">累計をリセット</button>`;

      usagePanel.innerHTML = html;
      usagePanel.querySelector('#nicofilter-reset-usage').onclick = () => {
        GM_setValue(USAGE_STORAGE, { totalInput: 0, totalOutput: 0, totalCostUSD: 0, history: [] });
        renderUsagePanel();
      };
    }

    // Tab switching
    const tabs = { chat: chatPanel, settings: settingsPanel, usage: usagePanel };
    const tabBtns = { chat: chatTab, settings: settingsTab, usage: usageTab };
    function switchTab(tab) {
      for (const [key, panel] of Object.entries(tabs)) {
        panel.style.display = key === tab ? (key === 'chat' ? 'flex' : 'block') : 'none';
        tabBtns[key].style.cssText = tabStyle(key === tab);
      }
      if (tab === 'usage') renderUsagePanel();
    }
    chatTab.onclick = () => switchTab('chat');
    settingsTab.onclick = () => switchTab('settings');
    usageTab.onclick = () => switchTab('usage');

    modal.append(header, chatPanel, settingsPanel, usagePanel);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    // APIキー未設定なら設定タブを先に開く
    if (!loadApiKey()) switchTab('settings');

    function renderMarkdown(md) {
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const inline = s => esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, `<code style="background:${NC.bg};padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>`);

      const lines = md.split('\n');
      let html = '';
      let inList = false;

      for (const raw of lines) {
        const line = raw.trimEnd();

        if (line === '---' || line === '***') {
          if (inList) { html += '</ul>'; inList = false; }
          html += `<hr style="border:none;border-top:1px solid ${NC.border};margin:8px 0;">`;
          continue;
        }

        const hMatch = line.match(/^(#{1,4})\s+(.+)/);
        if (hMatch) {
          if (inList) { html += '</ul>'; inList = false; }
          const sz = { 1:'16px', 2:'15px', 3:'14px', 4:'13px' }[hMatch[1].length];
          html += `<div style="font-size:${sz};font-weight:bold;margin:8px 0 4px;">${inline(hMatch[2])}</div>`;
          continue;
        }

        const liMatch = line.match(/^(\s*)[-*]\s+(.+)/);
        if (liMatch) {
          if (!inList) { html += '<ul style="margin:4px 0;padding-left:20px;">'; inList = true; }
          const liContent = liMatch[2];
          const suggMatch = liContent.match(/^\[提案\]\s*(.+)/);
          if (suggMatch) {
            const label = suggMatch[1];
            html += `<li style="margin:4px 0;list-style:none;margin-left:-16px;"><button class="nicofilter-suggest" data-suggest="${esc(label)}" style="background:${NC.actionBase};border:1px solid ${NC.border};border-radius:4px;color:${NC.text};padding:6px 12px;cursor:pointer;font-size:13px;text-align:left;width:100%;transition:background 0.15s;">▶ ${inline(label)}</button></li>`;
          } else {
            html += `<li style="margin:2px 0;">${inline(liContent)}</li>`;
          }
          continue;
        }

        if (inList) { html += '</ul>'; inList = false; }

        const suggestLineMatch = line.match(/^\[提案\]\s*(.+)/);
        if (suggestLineMatch) {
          const label = suggestLineMatch[1];
          html += `<div style="margin:4px 0;"><button class="nicofilter-suggest" data-suggest="${esc(label)}" style="background:${NC.actionBase};border:1px solid ${NC.border};border-radius:4px;color:${NC.text};padding:6px 12px;cursor:pointer;font-size:13px;text-align:left;width:100%;transition:background 0.15s;">▶ ${inline(label)}</button></div>`;
          continue;
        }

        if (line === '') {
          html += '<div style="height:6px;"></div>';
        } else {
          html += `<div>${inline(line)}</div>`;
        }
      }
      if (inList) html += '</ul>';
      return html;
    }

    const AI_ICON_URL = 'https://i.imgur.com/IvkypaS.png';

    function addBubble(role, text) {
      const isUser = role === 'user';
      let bubble;
      if (isUser) {
        bubble = document.createElement('div');
        bubble.style.cssText = `padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.6;max-width:90%;word-break:break-word;background:${NC.azure};color:${NC.azureText};align-self:flex-end;white-space:pre-wrap;`;
        bubble.textContent = text;
      } else {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;align-self:flex-start;max-width:90%;';
        const icon = document.createElement('img');
        icon.src = AI_ICON_URL;
        icon.style.cssText = 'width:32px;height:32px;border-radius:50%;flex-shrink:0;margin-top:2px;object-fit:cover;';
        const content = document.createElement('div');
        content.style.cssText = `padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.6;word-break:break-word;background:${NC.bgMedium};color:${NC.text};flex:1;min-width:0;`;
        content.innerHTML = renderMarkdown(text);
        row.append(icon, content);
        bubble = row;
        const suggestBtns = content.querySelectorAll('.nicofilter-suggest');
        if (suggestBtns.length > 0) {
          const selected = new Set();

          function updateExecBtn() {
            let execBtn = content.querySelector('.nicofilter-exec');
            if (selected.size > 0 && !execBtn) {
              execBtn = document.createElement('button');
              execBtn.className = 'nicofilter-exec';
              execBtn.style.cssText = `background:${NC.azure};border:none;border-radius:4px;color:${NC.azureText};padding:8px 16px;cursor:pointer;font-size:13px;font-weight:bold;margin-top:8px;width:100%;`;
              execBtn.onmouseenter = () => { execBtn.style.background = NC.azureHover; };
              execBtn.onmouseleave = () => { execBtn.style.background = NC.azure; };
              execBtn.onclick = () => {
                const msg = '以下を実行してください。確認は不要です。\n' + [...selected].join('\n');
                suggestBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.cursor = 'default'; });
                execBtn.remove();
                sendMessage(msg);
              };
              content.appendChild(execBtn);
            }
            if (execBtn) {
              execBtn.textContent = `選択した ${selected.size} 件を実行`;
              if (selected.size === 0) execBtn.remove();
            }
          }

          suggestBtns.forEach(btn => {
            let isSelected = false;
            btn.onclick = () => {
              isSelected = !isSelected;
              const label = btn.dataset.suggest;
              if (isSelected) {
                selected.add(label);
                btn.style.background = NC.azure;
                btn.style.color = NC.azureText;
                btn.style.borderColor = NC.azure;
              } else {
                selected.delete(label);
                btn.style.background = NC.actionBase;
                btn.style.color = NC.text;
                btn.style.borderColor = NC.border;
              }
              updateExecBtn();
            };
            btn.onmouseenter = () => { if (!isSelected) btn.style.background = NC.actionHover; };
            btn.onmouseleave = () => { if (!isSelected) btn.style.background = NC.actionBase; };
          });
        }
      }
      chatLog.appendChild(bubble);
      chatLog.scrollTop = chatLog.scrollHeight;
      return bubble;
    }

    const spinnerCSS = `@keyframes nicofilter-spin{to{transform:rotate(360deg)}}`;
    if (!document.getElementById('nicofilter-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'nicofilter-spinner-style';
      style.textContent = spinnerCSS;
      document.head.appendChild(style);
    }

    function addStatusBubble(text, { spinner = false } = {}) {
      const bubble = document.createElement('div');
      bubble.style.cssText = `padding:8px 14px;border-radius:8px;font-size:12px;color:${NC.textLow};align-self:flex-start;display:flex;align-items:center;gap:8px;`;
      if (spinner) {
        const spin = document.createElement('span');
        spin.style.cssText = `display:inline-block;width:14px;height:14px;border:2px solid ${NC.border};border-top-color:${NC.azure};border-radius:50%;animation:nicofilter-spin 0.8s linear infinite;flex-shrink:0;`;
        bubble.appendChild(spin);
      }
      const label = document.createElement('span');
      label.textContent = text;
      bubble.appendChild(label);
      chatLog.appendChild(bubble);
      chatLog.scrollTop = chatLog.scrollHeight;
      return bubble;
    }

    async function sendMessage(userText) {
      if (isSending) return;
      isSending = true;
      sendBtn.disabled = true;
      sendBtn.style.opacity = '0.5';

      if (userText !== null) {
        addBubble('user', userText);
        recordTranscript('user', userText);
        conversationMessages.push({ role: 'user', content: userText });
      }

      const thinking = addStatusBubble('考え中...', { spinner: true });

      try {
        const response = await callLLM(
          conversationMessages, TOOLS, CHAT_SYSTEM_PROMPT,
          { maxTokens: 8192, cacheConversation: true }
        );
        if (response.usage) recordUsage(loadModel(), response.usage);

        thinking.remove();

        const toolCalls = response.content.filter(b => b.type === 'tool_use');
        const textBlocks = response.content.filter(b => b.type === 'text');
        const text = textBlocks.map(b => b.text).join('\n');

        if (text) {
          addBubble('assistant', text);
          recordTranscript('assistant', text);
        }

        conversationMessages.push({ role: 'assistant', content: response.content });

        if (toolCalls.length > 0) {
          let unresolvedCount = 0;
          for (const tc of toolCalls) {
            if (tc.name === 'hide_comments') {
              const { ids, unresolved } = expandIds(tc.input.ids);
              tc.input.ids = ids;
              unresolvedCount += unresolved;
            } else if (tc.name === 'replace_comments') {
              const seen = new Set();
              const expanded = [];
              const replacements = Array.isArray(tc.input.replacements) ? tc.input.replacements : Object.values(tc.input.replacements ?? {});
              for (const r of replacements) {
                const realId = resolveCommentToken(r.id);
                if (realId === null) { unresolvedCount++; continue; }
                const siblings = bodyToIds.get(commentMap[realId]?.body);
                const ids = siblings || [realId];
                for (const id of ids) {
                  if (!seen.has(id)) {
                    seen.add(id);
                    expanded.push({ id, new_body: r.new_body });
                  }
                }
              }
              tc.input.replacements = expanded;
            } else if (tc.name === 'hide_user') {
              const tags = (Array.isArray(tc.input.user_ids) ? tc.input.user_ids : typeof tc.input.user_ids === 'string' ? [tc.input.user_ids] : Object.values(tc.input.user_ids ?? {}).flat()).map(String);
              const realIds = [];
              for (const tag of tags) {
                const t = tag.trim();
                if (userTagToId.has(t)) realIds.push(userTagToId.get(t));
                else if (userIdToTag.has(t)) realIds.push(t);
                else unresolvedCount++;
              }
              tc.input.user_ids = realIds;
            }
          }

          const { hiddenIds, replacedIds, hideCommentCount, replaceCommentCount, hideUserCalls, hideUserCount, hideUserCommentCount } = executeToolCalls(toolCalls, store, player);

          // 永続化用に本文キーで記録する
          for (const id of hiddenIds) {
            const b = commentMap[id]?.body;
            if (b !== undefined) hiddenBodies.add(b);
          }
          for (const tc of toolCalls) {
            if (tc.name !== 'replace_comments') continue;
            for (const r of tc.input.replacements || []) {
              const b = commentMap[r.id]?.body;
              if (b !== undefined) replacedByBody[b] = r.new_body;
            }
          }

          const resultLines = [];
          if (hiddenIds.length > 0) resultLines.push(`${hiddenIds.length} 件を粛清したのだ`);
          if (replacedIds.length > 0) resultLines.push(`${replacedIds.length} 件を書き換えたのだ`);
          if (resultLines.length > 0) {
            const allIds = [...hiddenIds, ...replacedIds];
            const summaryParts = [];
            if (hideCommentCount > 0) summaryParts.push(`コメント非表示: ${hideCommentCount} 件`);
            if (hideUserCalls > 0) summaryParts.push(`ユーザー非表示: ${hideUserCount} ユーザー (${hideUserCommentCount} 件)`);
            if (replaceCommentCount > 0) summaryParts.push(`コメント書き換え: ${replaceCommentCount} 件`);
            const summaryLine = summaryParts.length > 0 ? summaryParts.join(' / ') + '\n\n' : '';
            // 各行に粛清理由（分類カテゴリ / チャット指示 / 書き換え）を付ける
            const replacedSet = new Set(replacedIds);
            const resolved = allIds
              .map(id => {
                const c = commentMap[id];
                if (!c) return null;
                let label;
                if (replacedSet.has(id)) {
                  label = '書き換え';
                } else {
                  const catKey = verdictsByBody[c.body];
                  label = FILTER_CATEGORIES.find(fc => fc.key === catKey)?.label || 'チャット指示';
                }
                return { vposMs: c.vposMs ?? 0, line: `[${formatVpos(c.vposMs)}]【${label}】${c.body}` };
              })
              .filter(Boolean)
              .sort((a, b) => a.vposMs - b.vposMs)
              .map(r => r.line);
            const unresolved = allIds.length - resolved.length;
            const details = summaryLine + resolved.join('\n')
              + (unresolved > 0 ? `\n(他 ${unresolved} 件は重複展開分)` : '');
            const bubble = document.createElement('div');
            bubble.style.cssText = `padding:8px 14px;border-radius:8px;font-size:12px;color:${NC.textLow};align-self:flex-start;`;
            bubble.innerHTML = `${resultLines.join(' / ')}<details style="margin-top:6px;"><summary style="cursor:pointer;color:${NC.textLow};font-size:11px;">詳細を表示</summary><pre style="margin-top:4px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:${NC.textLow};max-height:300px;overflow-y:auto;">${details.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></details>`;
            chatLog.appendChild(bubble);
            chatLog.scrollTop = chatLog.scrollHeight;
            recordTranscript('status', resultLines.join(' / '));
          }

          if (unresolvedCount > 0) {
            addStatusBubble(`⚠ ${unresolvedCount} 件の指定は該当するコメント/ユーザーが見つからなかったのだ`);
          }

          const toolResults = toolCalls.map(tc => ({
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: 'done'
          }));
          conversationMessages.push({ role: 'user', content: toolResults });
        }

        persistSession();
      } catch (err) {
        thinking.remove();
        addBubble('assistant', 'エラーが発生したのだ: ' + err.message);
      } finally {
        isSending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
      }
    }

    sendBtn.addEventListener('click', () => {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      sendMessage(text);
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        sendMessage(text);
      }
    });

    // ========== 分類実行 ==========

    function buildMetaSection() {
      const meta = getVideoMetadata();
      const metaLines = [];
      if (meta.title) metaLines.push(`動画タイトル: ${meta.title}`);
      if (meta.tags.length > 0) metaLines.push(`タグ: ${meta.tags.join('、')}`);
      return metaLines.length > 0 ? `## 動画情報\n${metaLines.join('\n')}\n\n` : '';
    }

    function formatEta(sec) {
      if (sec < 60) return `約${sec}秒`;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `約${m}分${s}秒` : `約${m}分`;
    }

    // これまでのスループット（完了チャンク/経過時間）から残り時間を推定する。
    // 最初の完了までは推定できないので件数だけ出す。進むにつれ収束する
    function createProgressReporter(label, total, onProgress) {
      const startTime = Date.now();
      let done = 0;
      function report() {
        if (done === 0 || done >= total) {
          onProgress(`${label}... ${done}/${total}`);
          return;
        }
        const elapsedSec = (Date.now() - startTime) / 1000;
        const remainSec = Math.max(1, Math.ceil((elapsedSec / done) * (total - done)));
        onProgress(`${label}... ${done}/${total}（残り${formatEta(remainSec)}）`);
      }
      report();
      return () => { done++; report(); };
    }

    // Jev は1回のリクエストで全コメントに型付きの判定（確率つき）を返すので、
    // LLM 版の2重スイープやキャッシュの温めは不要。チャンクを並列に1回流すだけ
    async function classifyWithJev(onProgress) {
      const apiKey = loadApiKeyFor('typesafe');
      const meta = getVideoMetadata();
      const verdictMap = new Map();
      const queue = chunkForJev(uniqueComments, meta);
      const chunkDone = createProgressReporter('分類中（Jev）', queue.length, onProgress);
      let missing = 0;
      // 実際に何本同時に飛んでいるかの計測（GM_xmlhttpRequest はページの Network タブに出ないため）
      const startedAt = performance.now();
      const timings = [];
      let inFlight = 0;
      let maxInFlight = 0;

      async function worker() {
        while (queue.length > 0) {
          const chunk = queue.shift();
          const sentAt = performance.now();
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          const response = await callJev(apiKey, buildJevRequest(chunk, meta));
          inFlight--;
          const doneAt = performance.now();
          timings.push({ 件数: chunk.length, 送信ms: Math.round(sentAt - startedAt), 完了ms: Math.round(doneAt - startedAt), 所要ms: Math.round(doneAt - sentAt) });
          if (response.usage) recordUsage(JEV_MODEL.id, response.usage);
          for (const c of chunk) {
            const answer = response.answers?.[`c${c.index}`];
            if (!answer) { missing++; continue; }
            const cat = decideJevCategory(answer.probabilities);
            if (cat) verdictMap.set(c.index, cat);
          }
          chunkDone();
        }
      }
      const workers = [];
      // worker は起動した瞬間にキューから1つ取るので、起動数は取り出す前の長さで決める
      const workerCount = Math.min(JEV_CONCURRENCY, queue.length);
      for (let i = 0; i < workerCount; i++) workers.push(worker());
      await Promise.all(workers);
      const wallMs = performance.now() - startedAt;
      // こちらは常に JEV_CONCURRENCY 本を「送信中」にするが、GM_xmlhttpRequest の内部で順番待ちになると
      // 所要時間が延びるだけで区別がつかない。最短の所要時間を「1本だけの処理時間」とみなし、
      // 全体の経過時間から実際の同時処理数を推定する（直列なら 1 前後）
      const minMs = Math.min(...timings.map(t => t.所要ms));
      console.log(`[nicofilter] Jev: ${timings.length} リクエスト / ${(wallMs / 1000).toFixed(1)} 秒, `
        + `送信中の最大 ${maxInFlight} 本, 最短 ${minMs}ms, 推定同時処理数 ${(timings.length * minMs / wallMs).toFixed(1)}`);
      console.table(timings);
      if (missing > 0) console.warn(`[nicofilter] Jev の回答が欠けたコメント: ${missing} 件（ok 扱い）`);
      return verdictMap;
    }

    // チャンク境界をずらした2本の独立スイープを同じワーカープールに同時に流し、
    // 問題判定の和集合を取る（取りこぼし対策。境界が変わると文脈のまとまりが変わるため、
    // 片方が拾い損ねたコメントをもう片方が拾える。直列の検証パスと違い待ち時間が増えない）
    async function classifyAllComments(onProgress) {
      if (loadClassifier() === 'jev') return classifyWithJev(onProgress);

      // 動画情報は全チャンク共通なのでシステムプロンプト側に置き、
      // ツール定義+システムをキャッシュ可能な安定プレフィックスとして共有する
      const metaSection = buildMetaSection();
      const system = metaSection ? `${FILTER_SYSTEM_PROMPT}\n\n${metaSection.trim()}` : FILTER_SYSTEM_PROMPT;
      const verdictMap = new Map(); // index -> category（問題判定のみ。未登録 = ok）
      const priority = new Map(FILTER_CATEGORIES.map((fc, i) => [fc.key, i]));

      function makeChunks(offset) {
        const chunks = [];
        if (offset > 0) chunks.push(uniqueComments.slice(0, offset));
        for (let i = offset; i < uniqueComments.length; i += CLASSIFY_CHUNK_SIZE) {
          chunks.push(uniqueComments.slice(i, i + CLASSIFY_CHUNK_SIZE));
        }
        return chunks.filter(c => c.length > 0);
      }

      const offset = Math.floor(CLASSIFY_CHUNK_SIZE / 2);
      const queue = makeChunks(0);
      if (uniqueComments.length > offset) queue.push(...makeChunks(offset));
      const total = queue.length;
      // Anthropic はウォームアップ（1本目の直列実行）を含むため、直後は残り時間が過大に出る
      const chunkDone = createProgressReporter('分類中', total, onProgress);

      async function processChunk(chunk) {
        const lines = chunk.map(c => `#${c.index}\t${c.body.replace(/\s*\n\s*/g, ' ')}`).join('\n');
        const message = `以下のコメント ${chunk.length} 件から、問題のあるコメントを報告してください。\n\n${lines}`;
        const response = await callLLM(
          [{ role: 'user', content: message }],
          [CLASSIFY_TOOL],
          system,
          { maxTokens: 4096, temperature: 0, toolChoice: 'classify_comments', lowLatency: true, cacheSystem: true }
        );
        if (response.usage) recordUsage(loadModel(), response.usage);
        for (const block of response.content) {
          if (block.type !== 'tool_use' || block.name !== 'classify_comments') continue;
          const input = block.input || {};
          for (const fc of FILTER_CATEGORIES) {
            const arr = Array.isArray(input[fc.key]) ? input[fc.key] : [];
            for (const raw of arr) {
              const idx = Number(String(raw).replace(/^#/, ''));
              if (!indexToComment.has(idx)) continue;
              const existing = verdictMap.get(idx);
              // 2スイープの判定が食い違ったら優先度の高いカテゴリを採用
              if (existing === undefined || priority.get(fc.key) < priority.get(existing)) {
                verdictMap.set(idx, fc.key);
              }
            }
          }
        }
        chunkDone();
      }

      // Anthropic のキャッシュエントリは最初のレスポンス完了後に読めるようになるため、
      // 全並列で投げると全リクエストがキャッシュミス（全額課金）になる。
      // 1本目だけ先行してキャッシュを温めてから、残りを並列で流す
      if (getModelInfo(loadModel()).provider === 'anthropic' && queue.length > 1) {
        await processChunk(queue.shift());
      }

      async function worker() {
        while (queue.length > 0) {
          await processChunk(queue.shift());
        }
      }
      const workers = [];
      const workerCount = Math.min(CLASSIFY_CONCURRENCY, queue.length); // 起動時にキューが減る前の長さで決める
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      return verdictMap;
    }

    // 分類結果からカテゴリ単位の提案ボタンを表示（実行は LLM を介さず JS で確定的に行う）
    function renderCategorySuggestions(byCat) {
      const available = FILTER_CATEGORIES
        .map(fc => ({ key: fc.key, label: fc.label, comments: byCat[fc.key] || [] }))
        .filter(fc => fc.comments.length > 0);
      if (available.length === 0) return;

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;align-self:flex-start;max-width:90%;width:100%;';
      const icon = document.createElement('img');
      icon.src = AI_ICON_URL;
      icon.style.cssText = 'width:32px;height:32px;border-radius:50%;flex-shrink:0;margin-top:2px;object-fit:cover;';
      const content = document.createElement('div');
      content.style.cssText = `padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.6;background:${NC.bgMedium};color:${NC.text};flex:1;min-width:0;`;
      const head = document.createElement('div');
      head.textContent = '分類結果に基づくフィルター提案なのだ（選んで実行）:';
      content.appendChild(head);

      const selected = new Set();
      const btns = [];
      let execBtn = null;
      let executed = false;

      function executeSelected() {
        executed = true;
        const chosen = available.filter(fc => selected.has(fc.key));
        const targets = chosen.flatMap(fc => fc.comments);
        const allIds = [...new Set(targets.flatMap(c => bodyToIds.get(c.body) || [c.id]))];
        btns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.cursor = 'default'; });
        if (execBtn) execBtn.remove();

        executeToolCalls([{ name: 'hide_comments', input: { ids: allIds } }], store, player);

        const labels = chosen.map(fc => fc.label).join('、');
        const detailLines = chosen
          .flatMap(fc => fc.comments.map(c => ({ c, label: fc.label })))
          .sort((a, b) => a.c.vposMs - b.c.vposMs)
          .map(({ c, label }) => `[${formatVpos(c.vposMs)}]【${label}】${c.body}`)
          .join('\n');
        const bubble = document.createElement('div');
        bubble.style.cssText = `padding:8px 14px;border-radius:8px;font-size:12px;color:${NC.textLow};align-self:flex-start;`;
        bubble.innerHTML = `${allIds.length} 件を粛清したのだ（${labels}）<details style="margin-top:6px;"><summary style="cursor:pointer;color:${NC.textLow};font-size:11px;">詳細を表示</summary><pre style="margin-top:4px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:${NC.textLow};max-height:300px;overflow-y:auto;">${detailLines.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></details>`;
        chatLog.appendChild(bubble);
        chatLog.scrollTop = chatLog.scrollHeight;

        // 会話履歴にも記録して、以降のチャット指示が状況を把握できるようにする
        const indexNote = targets.length <= 100 ? `（番号: ${targets.map(c => '#' + c.index).join(' ')}）` : '';
        conversationMessages.push({
          role: 'user',
          content: `（システム通知）AIフィルターの分類結果に基づき、カテゴリ「${labels}」のコメント ${allIds.length} 件${indexNote}を非表示にした。これはユーザーのボタン操作によるもので、返信は不要。`
        });

        targets.forEach(c => hiddenBodies.add(c.body));
        recordTranscript('status', `${allIds.length} 件を粛清したのだ（${labels}）`);
        persistSession();
      }

      function updateExecBtn() {
        if (executed) return;
        if (selected.size > 0 && !execBtn) {
          execBtn = document.createElement('button');
          execBtn.style.cssText = `background:${NC.azure};border:none;border-radius:4px;color:${NC.azureText};padding:8px 16px;cursor:pointer;font-size:13px;font-weight:bold;margin-top:8px;width:100%;`;
          execBtn.onclick = executeSelected;
          content.appendChild(execBtn);
        }
        if (execBtn) {
          if (selected.size === 0) {
            execBtn.remove();
            execBtn = null;
            return;
          }
          const total = available.filter(fc => selected.has(fc.key)).reduce((n, fc) => n + fc.comments.length, 0);
          execBtn.textContent = `選択した ${total} 件を粛清`;
        }
      }

      for (const fc of available) {
        const btn = document.createElement('button');
        btn.textContent = `▶ ${fc.label} ${fc.comments.length} 件を粛清`;
        btn.style.cssText = `display:block;background:${NC.actionBase};border:1px solid ${NC.border};border-radius:4px;color:${NC.text};padding:6px 12px;cursor:pointer;font-size:13px;text-align:left;width:100%;margin-top:6px;transition:background 0.15s;`;
        let isSelected = false;
        btn.onclick = () => {
          if (executed) return;
          isSelected = !isSelected;
          if (isSelected) {
            selected.add(fc.key);
            btn.style.background = NC.azure;
            btn.style.color = NC.azureText;
            btn.style.borderColor = NC.azure;
          } else {
            selected.delete(fc.key);
            btn.style.background = NC.actionBase;
            btn.style.color = NC.text;
            btn.style.borderColor = NC.border;
          }
          updateExecBtn();
        };
        btn.onmouseenter = () => { if (!isSelected && !executed) btn.style.background = NC.actionHover; };
        btn.onmouseleave = () => { if (!isSelected) btn.style.background = NC.actionBase; };
        btns.push(btn);
        content.appendChild(btn);
      }

      row.append(icon, content);
      chatLog.appendChild(row);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    // Start button
    function startAnalysis() {
      const apiKey = loadApiKey();
      if (!apiKey) {
        addStatusBubble('APIキーを設定タブで入力してください。');
        switchTab('settings');
        return;
      }
      // Jev は分類だけを担当し、治安評価とチャットは選択中の LLM が行うので両方のキーが要る
      if (loadClassifier() === 'jev' && !loadApiKeyFor('typesafe')) {
        addStatusBubble('分類モデルに Jev を選んでいます。TypeSafe API キーを設定タブで入力してください。');
        switchTab('settings');
        return;
      }
      const status = addStatusBubble(`コメント ${uniqueComments.length} 件を分析中...`, { spinner: true });
      const setStatus = (text) => { status.lastChild.textContent = text; };
      (async () => {
        isSending = true;
        sendBtn.disabled = true;
        sendBtn.style.opacity = '0.5';
        try {
          const verdictMap = await classifyAllComments(setStatus);
          const byCat = {};
          for (const c of uniqueComments) {
            const cat = verdictMap.get(c.index) ?? 'ok';
            (byCat[cat] ??= []).push(c);
          }
          // 永続化用に本文キーで判定を記録する
          for (const [idx, cat] of verdictMap) {
            const c = indexToComment.get(idx);
            if (c) verdictsByBody[c.body] = cat;
          }

          setStatus('治安を評価中...');
          const summaryLines = FILTER_CATEGORIES
            .map(fc => `- ${fc.label}: ${(byCat[fc.key] || []).length} 件`)
            .join('\n');
          const commentLines = uniqueComments.map(formatCommentLine).join('\n');
          const initialMessage = `${buildMetaSection()}## AIフィルター分類結果（総コメント ${uniqueComments.length} 件、重複除去済み）\n${summaryLines}\n\n## コメント一覧\n${commentLines}\n\nこの分類結果とコメントを踏まえて、治安を評価してほしいのだ。`;
          conversationMessages.push({ role: 'user', content: initialMessage });

          // 初回評価はツールなしで呼ぶ（tool_use が孤立して以降の呼び出しが壊れるのを防ぐ）。
          // コメント一覧を含む会話をキャッシュし、以降のチャットの入力コストを下げる
          const response = await callLLM(conversationMessages, null, CHAT_SYSTEM_PROMPT, { maxTokens: 8192, cacheConversation: true });
          if (response.usage) recordUsage(loadModel(), response.usage);
          status.remove();
          const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text) {
            addBubble('assistant', text);
            recordTranscript('assistant', text);
          }
          conversationMessages.push({ role: 'assistant', content: response.content });

          renderCategorySuggestions(byCat);
          persistSession();
        } catch (err) {
          status.remove();
          addBubble('assistant', 'エラーが発生したのだ: ' + err.message);
        } finally {
          isSending = false;
          sendBtn.disabled = false;
          sendBtn.style.opacity = '1';
        }
      })();
    }

    // ========== セッション復元 ==========

    function restoreSession(session) {
      conversationMessages.push(...(session.conversation || []));
      transcript.push(...(session.transcript || []));
      Object.assign(verdictsByBody, session.verdicts || {});
      (session.hiddenBodies || []).forEach(b => hiddenBodies.add(b));
      Object.assign(replacedByBody, session.replaced || {});

      // 対話ログを再描画
      for (const entry of transcript) {
        if (entry.role === 'status') addStatusBubble(entry.text);
        else addBubble(entry.role, entry.text);
      }

      // フィルターを再適用（自動適用が既に走っていても本文キーなので冪等）
      const applied = applyStoredFilters(session, store, player);
      const when = (session.updatedAt || '').replace('T', ' ').slice(0, 16);
      addStatusBubble(`前回のセッション（${when}）を復元したのだ` + (applied > 0 ? `。フィルター ${applied} 件を再適用` : ''));

      // 未実行の分類結果が残っていれば提案ボタンも復元する
      const byCat = {};
      for (const c of uniqueComments) {
        const cat = verdictsByBody[c.body];
        if (cat && !hiddenBodies.has(c.body)) (byCat[cat] ??= []).push(c);
      }
      renderCategorySuggestions(byCat);
    }

    const hasSavedSession = savedSession
      && ((savedSession.conversation || []).length > 0 || Object.keys(savedSession.verdicts || {}).length > 0);

    if (hasSavedSession) {
      restoreSession(savedSession);
    } else {
      const startBtn = document.createElement('button');
      startBtn.textContent = `▶ コメント ${uniqueComments.length} 件を分析`;
      startBtn.style.cssText = `background:${NC.azure};border:none;border-radius:6px;color:${NC.azureText};padding:12px 24px;cursor:pointer;font-size:14px;font-weight:bold;margin:auto;`;
      startBtn.onmouseenter = () => { startBtn.style.background = NC.azureHover; };
      startBtn.onmouseleave = () => { startBtn.style.background = NC.azure; };
      startBtn.onclick = () => {
        startBtn.remove();
        startAnalysis();
      };
      chatLog.appendChild(startBtn);
    }
  }

  // ========== ボタン注入 ==========

  const FILTER_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;

  function injectButton() {
    const commentBtn = document.querySelector(
      '[aria-label="コメントを非表示にする"], [aria-label="コメントを表示する"]'
    );
    if (!commentBtn) return false;

    const tooltipRoot = commentBtn.closest('[data-scope]') || commentBtn.parentElement?.parentElement;
    if (!tooltipRoot) return false;
    const controlBar = tooltipRoot.parentElement;
    if (!controlBar) return false;

    if (document.getElementById('nicofilter-btn-wrap')) return true;

    const refButton = commentBtn.tagName === 'BUTTON' ? commentBtn : commentBtn.querySelector('button');
    const btnClass = refButton ? refButton.className : '';

    const wrap = document.createElement('div');
    wrap.id = 'nicofilter-btn-wrap';
    wrap.style.cssText = 'display:inline-flex;align-items:center;';

    const filterBtn = document.createElement('button');
    filterBtn.id = 'nicofilter-btn';
    filterBtn.title = 'ニコニコライエジョフ';
    filterBtn.className = btnClass;
    filterBtn.style.cssText += ';opacity:0.5;transition:opacity 0.2s;cursor:pointer;';
    filterBtn.innerHTML = FILTER_ICON_SVG;

    filterBtn.addEventListener('click', () => {
      const result = findStoreAndPlayer();
      if (!result) {
        console.error('[nicofilter] ストア/プレイヤーが見つかりません');
        return;
      }
      openChatModal(result.store, result.player);
    });

    wrap.appendChild(filterBtn);
    controlBar.insertBefore(wrap, tooltipRoot);

    return true;
  }

  // ========== 初期化 ==========

  function main() {
    GM_registerMenuCommand('ニコニコライエジョフ', () => {
      const result = findStoreAndPlayer();
      if (result) openChatModal(result.store, result.player);
    });

    const observer = new MutationObserver(() => {
      if (!document.getElementById('nicofilter-btn-wrap')) {
        injectButton();
      }
      scheduleAutoApply(); // SPA遷移で動画が変わった場合もここで拾う
    });

    observer.observe(document.body, { childList: true, subtree: true });
    injectButton();
    scheduleAutoApply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();

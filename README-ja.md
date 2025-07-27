# CC Discord Bot

Discord チャンネルに Claude Code を統合し、AI による支援と自動化を実現する Discord ボットです。

## 機能

- **Discord 統合**: Discord サーバーに Claude Code をシームレスに接続
- **スレッド管理**: 整理された会話のために自動的にスレッドを作成
- **多言語サポート**: 日本語と英語に対応
- **Never Sleep モード**: アイドル時にタスクを自動実行
- **デバッグモード**: API 呼び出しなしで機能をテスト
- **セッション管理**: 前回の会話を再開

## 前提条件

- [Deno](https://deno.land/) 1.40 以降
- Discord ボットトークン
- Claude Code CLI がインストールされ認証済みであること

## インストール

1. リポジトリをクローン:

```bash
git clone https://github.com/yourusername/ccdiscord.git
cd ccdiscord
```

2. グローバルインストール（オプション）:

```bash
deno install -Afg ccdiscord.ts
```

## セットアップ

### 0. プライベート Discord サーバーの作成

⚠️ **重要**: まず、ボット専用のプライベート Discord サーバーを作成してください：

1. Discord を開き、サーバーリストの「+」ボタンをクリック
2. 「オリジナルの作成」→「自分と友達のため」を選択
3. サーバーに名前を付ける（例：「Claude Code Bot」）
4. チャンネルを右クリックして「チャンネル ID をコピー」（後で必要になります）

### 1. Discord ボットの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリックして名前を付ける
3. 左サイドバーの「Bot」セクションに移動
4. 「Add Bot」をクリック
5. 「Token」の下にある「Copy」をクリックしてボットトークンを取得
6. 「Privileged Gateway Intents」セクションで有効化:
   - Message Content Intent
7. 左サイドバーの「OAuth2」→「General」に移動
8. 「CLIENT ID」をコピー

### 2. ボットをサーバーに招待

1. 左サイドバーの「OAuth2」→「URL Generator」に移動
2. 以下のスコープを選択:
   - `bot`
3. 以下のボット権限を選択:
   - Send Messages（メッセージの送信）
   - Create Public Threads（公開スレッドの作成）
   - Send Messages in Threads（スレッドでメッセージを送信）
   - Read Message History（メッセージ履歴の読み取り）
4. 生成された URL をコピーしてブラウザで開く
5. あなたのプライベートサーバーを選択し「認証」をクリック

### 3. 環境変数の設定

プロジェクトディレクトリに `.env` ファイルを作成:

```bash
# Discord 設定（必須）
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_CHANNEL_ID=your_channel_id_here  # プライベートサーバーのチャンネルID

# オプション
SESSION_ID=unique_session_id  # 会話の継続用
DEBUG_MODE=false              # true でAPI呼び出しなしのテスト
NEVER_SLEEP=false            # true で自動タスク実行
```

**注意**: レガシー環境変数名もサポートしています：
- `CC_DISCORD_TOKEN` → `DISCORD_BOT_TOKEN`
- `CC_DISCORD_USER_ID` → `DISCORD_CLIENT_ID`
- `CC_DISCORD_CHANNEL_ID` → `DISCORD_CHANNEL_ID`

**重要**: Claude Code は内部認証を使用します。`ANTHROPIC_API_KEY` を設定しないでください。予期しない課金が発生する可能性があります。

## 使用方法

### 基本的な使用方法

ボットを起動:

```bash
deno run -A --env ccdiscord.ts
```

グローバルインストール済みの場合:

```bash
ccdiscord
```

### コマンドラインオプション

```
オプション:
  -c, --continue        最後のセッションから続行
  -r, --resume <id>     特定のセッションをIDで再開
  --list-sessions       再開可能なセッション一覧を表示
  -s, --select          セッションを対話的に選択
  --never-sleep         Never Sleep モードを有効化（タスク自動実行）
  -d, --debug           デバッグモードを有効化（ClaudeCode の代わりに DebugActor を使用）
  -h, --help            ヘルプメッセージを表示
  -l, --locale <lang>   言語を設定 (ja/en)
```

### 使用例

デバッグモードで起動（API 呼び出しなし）:

```bash
ccdiscord --debug
```

最後のセッションから続行:

```bash
ccdiscord --continue
```

日本語で起動:

```bash
ccdiscord --locale ja
```

Never Sleep モードを有効化:

```bash
ccdiscord --never-sleep
```

## Discord コマンド

ボットが実行されたら、Discord スレッドで以下のコマンドを使用できます:

- `!reset` または `!clear` - 会話をリセット
- `!stop` - 実行中のタスクを停止
- `!exit` - ボットを終了
- `!<command>` - シェルコマンドを実行
- 通常のメッセージ - Claude に支援を求める

## アーキテクチャ

このボットは Actor ベースのアーキテクチャを使用しています:

- **UserActor**: ユーザー入力の処理とルーティング
- **ClaudeCodeActor**: Claude API との通信
- **DebugActor**: テスト用のモック応答を提供
- **AutoResponderActor**: Never Sleep モードの管理
- **DiscordAdapter**: Discord 接続の管理
- **MessageBus**: Actor 間のメッセージルーティング

## 開発

### テストの実行

```bash
deno test --allow-all
```

### プロジェクト構造

```
ccdiscord/
├── src/
│   ├── actors/          # Actor 実装
│   ├── adapter/         # 外部サービスアダプター
│   ├── tests/           # テストファイル
│   ├── cli.ts           # CLI オプション処理
│   ├── config.ts        # 設定管理
│   ├── i18n.ts          # 国際化
│   ├── main.ts          # エントリーポイント
│   ├── message-bus.ts   # メッセージルーティング
│   └── types.ts         # 型定義
├── ccdiscord.ts         # メイン実行ファイル
├── README.md            # 英語ドキュメント
└── README-ja.md         # このファイル
```

## 設定

ボットは環境変数を通じて設定できます:

- `DISCORD_BOT_TOKEN` または `CC_DISCORD_TOKEN`: Discord ボットトークン（必須）
- `DISCORD_CHANNEL_ID` または `CC_DISCORD_CHANNEL_ID`: Discord チャンネル ID（必須）
- `DISCORD_CLIENT_ID` または `CC_DISCORD_USER_ID`: Discord クライアント/ユーザー ID（必須）
- `LANG`: 自動言語検出用のシステムロケール

**注意**: Claude Code は内部認証を使用します。`ANTHROPIC_API_KEY` を設定しないでください。

## セキュリティ注意事項

このボットは強力な権限を持ち、コマンドを実行します。信頼できる環境でのみ、注意して使用してください。

## ライセンス

MIT ライセンス

## 貢献

貢献は歓迎します！プルリクエストをお気軽に送信してください。

1. リポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

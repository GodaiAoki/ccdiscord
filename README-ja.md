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

### セキュリティ設定

1. **Claude Code 権限モード**:
   ```bash
   CLAUDE_PERMISSION_MODE=ask  # デフォルト: "ask" (推奨)
   ```
   - `ask`: コマンド実行前にユーザーの確認を求める（推奨）
   - `bypassPermissions`: 確認なしでコマンドを実行（危険）

2. **複数ユーザーアクセス制御**:
   ```bash
   DISCORD_ALLOWED_USERS=user_id1,user_id2,user_id3
   ```
   - カンマ区切りで複数のDiscordユーザーIDを指定可能
   - 未設定の場合は `DISCORD_CLIENT_ID` のユーザーのみアクセス可能

3. **監査ログ**:
   - すべてのユーザーアクション、認証失敗、ボットレスポンスが `./logs/audit/` に記録されます
   - ログはJSON形式で日付ごとにファイルが作成されます

4. **シェルコマンド実行**:
   - セキュリティ上の理由から、シェルコマンド実行機能（`!command`）は無効化されています
   - 必要な場合は、ソースコードを修正し、ホワイトリスト方式で実装してください

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

## 運用上の注意事項

### メッセージ出力の最適化

Claude Code の内部ツール（TodoWrite）により、以下のような中間メッセージが表示される場合があります：

```
📋 Tool execution result:
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.
```

これらのメッセージは正常な動作の一部ですが、出力量を抑制するために以下の運用方法を推奨します：

#### 推奨する依頼の仕方

1. **具体的で直接的な依頼**
   ```
   ❌ 避ける: "ステップバイステップでTodoアプリを作成してください"
   ✅ 推奨: "index.htmlをTodoアプリに上書きしてください。必要ならtodo.jsも作成してください"
   ```

2. **一度に一つのタスク**
   ```
   ❌ 避ける: 複数のタスクを同時に依頼し、「続けて」で追加要求
   ✅ 推奨: タスクの完了（✅）を待ってから次の依頼
   ```

3. **計画系の単語を避ける**
   - 「ステップバイステップ」
   - 「Todoリスト」
   - 「計画を立てて」
   
   これらの単語はClaude Codeの内部プランナーを起動し、中間メッセージが増える原因となります。

#### 設定による出力抑制（任意）

より静かな動作を希望する場合は、環境変数で設定できます：

```bash
# .env ファイルに追加
CLAUDE_TOOL_VERBOSE=false
SUPPRESS_TODOS_OUTPUT=true
```

#### AutoResponder の制御

このフォーク版では、AutoResponderは既定で無効化されています。有効にしたい場合：

```bash
# Never Sleep モード（自動タスク実行）を有効化
ENABLE_AUTO_RESPONDER=true
NEVER_SLEEP=true
```

### Docker/Devcontainer 環境での注意事項

Docker環境で実行する場合の追加設定：

1. **権限設定**
   ```bash
   # 非インタラクティブ運用には必須
   CLAUDE_PERMISSION_MODE=bypassPermissions
   ```

2. **Denoのインストール**
   ```dockerfile
   # Dockerfile で Deno を追加
   RUN curl -fsSL https://deno.land/install.sh | sh && \
       mv /root/.deno/bin/deno /usr/local/bin/deno
   ```

3. **Claude Code CLI のインストール**
   ```json
   // devcontainer.json
   "postCreateCommand": "npm i -g @anthropic-ai/claude-code"
   ```

### トラブルシューティング

| 問題 | 原因 | 解決方法 |
|------|------|----------|
| 前タスクの完了メッセージが繰り返し表示される | AutoResponderが有効 | `.env`から`ENABLE_AUTO_RESPONDER=true`を削除 |
| Todosメッセージが大量に出力される | 計画系の依頼文 | 具体的で直接的な依頼文に変更 |
| `!reset`後も古い情報が残る | セッション状態の不整合 | `!stop` → `!reset` → 新しい依頼 |

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

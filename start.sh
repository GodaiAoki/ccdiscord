#!/bin/bash
#
# CC Discord Bot Startup Script
# Improved with caffeinate support and Deno version check
#

set -e

# 色付き出力用のエスケープシーケンス
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}===========================================
CC Discord Bot Startup Script
=========================================== ${NC}"

# Denoのバージョンチェック
check_deno() {
    if ! command -v deno &> /dev/null; then
        echo -e "${RED}Error: Deno is not installed.${NC}"
        echo "Please install Deno from https://deno.land/"
        exit 1
    fi

    DENO_VERSION=$(deno --version | head -n1 | cut -d' ' -f2)
    echo -e "${YELLOW}Detected Deno version: $DENO_VERSION${NC}"

    # バージョン比較（最小バージョン: 2.0.0）
    REQUIRED_VERSION="2.0.0"
    if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$DENO_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
        echo -e "${YELLOW}Warning: Deno version $DENO_VERSION is older than recommended version $REQUIRED_VERSION${NC}"
        echo "Consider upgrading: deno upgrade"
    fi

    # 最新バージョンチェック（オプション）
    echo -e "${YELLOW}Checking for updates...${NC}"
    deno upgrade --dry-run 2>&1 | grep -E "A new release|latest" || echo "Deno is up to date"
}

# macOS用スリープ抑止設定
setup_caffeinate() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v caffeinate &> /dev/null; then
            echo -e "${GREEN}macOS detected: Using caffeinate to prevent sleep${NC}"
            CAFFEINATE_CMD="caffeinate -dimsu --"
        else
            echo -e "${YELLOW}macOS detected but caffeinate not available${NC}"
            CAFFEINATE_CMD=""
        fi
    else
        CAFFEINATE_CMD=""
    fi
}

# 起動モードの選択
select_mode() {
    echo -e "\n${GREEN}Select startup mode:${NC}"
    echo "1) Normal mode"
    echo "2) Debug mode"
    echo "3) Never Sleep mode (keeps bot always active)"
    echo "4) Resume session"
    echo "5) List sessions"
    echo "6) Select session"

    read -p "Enter your choice (1-6): " MODE

    case $MODE in
        1)
            echo -e "${GREEN}Starting in Normal mode...${NC}"
            CMD_ARGS=""
            ;;
        2)
            echo -e "${YELLOW}Starting in Debug mode...${NC}"
            CMD_ARGS="--debug"
            ;;
        3)
            echo -e "${YELLOW}Starting in Never Sleep mode...${NC}"
            CMD_ARGS="--never-sleep"
            ;;
        4)
            read -p "Enter session ID to resume: " SESSION_ID
            echo -e "${GREEN}Resuming session: $SESSION_ID${NC}"
            CMD_ARGS="--resume $SESSION_ID"
            ;;
        5)
            echo -e "${GREEN}Listing available sessions...${NC}"
            CMD_ARGS="--list-sessions"
            ;;
        6)
            echo -e "${GREEN}Selecting session...${NC}"
            CMD_ARGS="--select"
            ;;
        *)
            echo -e "${RED}Invalid option. Using Normal mode.${NC}"
            CMD_ARGS=""
            ;;
    esac
}

# エラーハンドラー
handle_error() {
    echo -e "\n${RED}Bot stopped unexpectedly!${NC}"
    echo "Check the logs in ./logs/ directory for details"
    echo ""
    read -p "Press Enter to exit or 'r' to restart: " RESTART
    if [ "$RESTART" = "r" ]; then
        main
    fi
}

# メイン処理
main() {
    echo ""
    echo -e "${GREEN}Initializing...${NC}"

    # Denoチェック
    check_deno

    # macOS caffeinate設定
    setup_caffeinate

    # モード選択
    select_mode

    # ログディレクトリ作成
    mkdir -p logs

    # 実行コマンド構築
    EXEC_CMD="$CAFFEINATE_CMD deno run -A --env ccdiscord.ts $CMD_ARGS"

    echo -e "\n${GREEN}Starting bot with command:${NC}"
    echo "$EXEC_CMD"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop the bot${NC}"
    echo -e "${GREEN}===========================================\n${NC}"

    # エラーハンドリングを有効にして実行
    trap handle_error ERR
    eval $EXEC_CMD || handle_error
}

# スクリプト開始
main
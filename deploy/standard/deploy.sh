#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 单台一键部署脚本
# 适用：Debian/Ubuntu，1-50家门店
# 用法：sudo bash deploy.sh
#
# 本脚本会将代码部署到 /var/www/foodflow，
# 然后调用 install-local.sh 完成后续安装（数据库、Redis、Node.js、Systemd、Nginx）
# ============================================================

set -e

# 设置非交互模式
export DEBIAN_FRONTEND=noninteractive

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 用户运行此脚本"
    exit 1
fi

echo ""
echo "=========================================="
echo "  FoodFlow 单台服务器部署"
echo "=========================================="
echo ""

# ===== 获取脚本所在目录和项目根目录 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
DEPLOY_TARGET="/var/www/foodflow"

log_info "项目源目录: $PROJECT_DIR"
log_info "部署目标目录: $DEPLOY_TARGET"

# ===== 1. 安装基础工具 =====
log_info "安装基础工具..."
apt-get update -qq
apt-get install -y -qq curl wget git rsync
log_success "基础工具安装完成"

# ===== 2. 部署代码到 /var/www/foodflow =====
echo ""
log_info "部署代码到 $DEPLOY_TARGET..."

# 创建目标目录
mkdir -p "$DEPLOY_TARGET"

if [ -d "$PROJECT_DIR/.git" ]; then
    # 本地开发环境：用 rsync 同步代码（排除 .git、node_modules 等）
    log_info "从本地目录同步代码..."
    rsync -a --delete \
        --exclude '.git' \
        --exclude 'node_modules' \
        --exclude 'uploads/*' \
        --exclude 'backups/*' \
        --exclude 'logs/*' \
        --exclude '.env' \
        "$PROJECT_DIR/" "$DEPLOY_TARGET/"
    log_success "代码同步完成"
elif [ -d "$DEPLOY_TARGET/.git" ]; then
    # 已部署过：git pull 更新
    log_info "检测到已部署，执行 git pull 更新..."
    cd "$DEPLOY_TARGET"
    git pull origin main || log_warn "git pull 失败，继续使用现有代码"
    log_success "代码更新完成"
else
    # 首次部署：git clone（根据目录名判断仓库）
    REPO_NAME=$(basename "$PROJECT_DIR")
    case "$REPO_NAME" in
        *enterprise-ultimate*|*ultimate*)
            GIT_REPO="https://github.com/Tony855/foodflow-enterprise-ultimate.git"
            ;;
        *enterprise*)
            GIT_REPO="https://github.com/Tony855/foodflow-enterprise.git"
            ;;
        *)
            GIT_REPO="https://github.com/Tony855/foodflow-standard.git"
            ;;
    esac
    log_info "克隆代码仓库: $GIT_REPO"

    if [ -d "$DEPLOY_TARGET" ] && [ "$(ls -A "$DEPLOY_TARGET")" ]; then
        BACKUP_DIR="$DEPLOY_TARGET.backup.$(date +%Y%m%d%H%M%S)"
        log_warn "目录已存在且非空，备份到 $BACKUP_DIR"
        mv "$DEPLOY_TARGET" "$BACKUP_DIR"
        mkdir -p "$DEPLOY_TARGET"
    fi

    git clone "$GIT_REPO" "$DEPLOY_TARGET"
    log_success "代码克隆完成"
fi

# 创建必要的子目录
mkdir -p "$DEPLOY_TARGET"/{uploads,backups,logs}

# ===== 3. 调用 install-local.sh 完成后续安装 =====
echo ""
log_info "调用 install-local.sh 完成后续安装（数据库、Redis、Node.js、Systemd、Nginx）..."
echo ""

if [ ! -f "$DEPLOY_TARGET/install-local.sh" ]; then
    log_error "未找到 install-local.sh，请确保代码完整"
    exit 1
fi

cd "$DEPLOY_TARGET"
bash install-local.sh

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  单台部署完成！${NC}"
echo "=========================================="
echo ""
echo "应用目录：$DEPLOY_TARGET"
echo "环境变量：$DEPLOY_TARGET/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
echo ""
echo "默认账号:"
echo "  超级管理员: superadmin / super123"
echo "  商户管理员: admin / admin123"
echo ""
log_warn "请及时修改默认管理员密码"
log_warn "建议配置 SSL 证书: cd $DEPLOY_TARGET && sudo bash setup-nginx.sh"
echo ""

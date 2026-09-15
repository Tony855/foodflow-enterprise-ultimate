#!/bin/bash
# ============================================================
# FoodFlow 企业旗舰版 - 集群一键部署脚本
# 适用：多商户/SaaS，多台应用服务器，可水平扩展
# 用法：sudo bash deploy.sh [master|slave]
#   master - 主节点（执行定时任务）
#   slave  - 从节点（不执行定时任务）
#
# 注意：集群部署需要独立的 MySQL、Redis、NFS 服务器，
# 请先编辑 /etc/foodflow/.env 配置正确的连接信息
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
    log_error "请使用 root 用户运行"
    exit 1
fi

NODE_TYPE=${1:-master}
echo ""
echo "=========================================="
echo "  FoodFlow 企业旗舰版 - 集群部署 ($NODE_TYPE)"
echo "=========================================="
echo ""

# ===== 1. 安装基础工具 =====
log_info "安装基础工具..."
apt-get update -qq
apt-get install -y -qq curl wget git nfs-common build-essential
log_success "基础工具安装完成"

# ===== 2. 安装 Node.js 20 LTS =====
if ! command -v node &> /dev/null; then
    log_info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    log_success "Node.js 安装完成: $(node -v)"
else
    log_success "Node.js 已安装: $(node -v)"
fi

# ===== 3. 创建目录 =====
log_info "创建目录..."
id -u www-data &>/dev/null || useradd -r -s /bin/false www-data
mkdir -p /var/www/foodflow/{logs,uploads,backups} /etc/foodflow /mnt/shared/uploads
log_success "目录创建完成"

# ===== 4. 部署代码 =====
log_info "部署代码到 /var/www/foodflow..."
if [ -d /var/www/foodflow/.git ]; then
    log_info "检测到已部署，执行 git pull 更新..."
    cd /var/www/foodflow
    git fetch origin && git reset --hard origin/main || log_warn "git pull 失败，继续使用现有代码"
else
    log_info "克隆代码仓库..."
    if [ -d "/var/www/foodflow" ] && [ "$(ls -A /var/www/foodflow)" ]; then
        BACKUP_DIR="/var/www/foodflow.backup.$(date +%Y%m%d%H%M%S)"
        log_warn "目录已存在且非空，备份到 $BACKUP_DIR"
        mv /var/www/foodflow "$BACKUP_DIR"
    fi
    git clone https://github.com/Tony855/foodflow-enterprise-ultimate.git /var/www/foodflow
fi
log_success "代码部署完成"

# ===== 5. 安装依赖 =====
log_info "安装 Node.js 依赖..."
cd /var/www/foodflow
npm install --production --no-audit --no-fund
log_success "依赖安装完成"

# ===== 6. 配置环境变量 =====
if [ ! -f /etc/foodflow/.env ]; then
    cp deploy/enterprise-ultimate/cluster/.env.example /etc/foodflow/.env
    log_warn "已创建 /etc/foodflow/.env，请编辑配置数据库、Redis、NFS 连接信息"
fi

# 从节点不执行定时任务
if [ "$NODE_TYPE" == "slave" ]; then
    sed -i '/^RUN_SCHEDULED_TASKS=/d' /etc/foodflow/.env
    echo "RUN_SCHEDULED_TASKS=false" >> /etc/foodflow/.env
    log_info "从节点：已禁用定时任务"
fi
chmod 600 /etc/foodflow/.env

# ===== 7. 配置 NFS（可选，需要用户手动配置服务器地址） =====
log_info "NFS 共享存储配置..."
log_warn "NFS 服务器地址需要手动配置，请编辑 /etc/foodflow/.env 中的 NFS_SERVER"
log_warn "然后手动执行: mount -t nfs \$NFS_SERVER:/export/uploads /mnt/shared/uploads"

# ===== 8. 配置 Systemd =====
log_info "配置 Systemd 服务..."
cp deploy/enterprise-ultimate/cluster/foodflow.service /etc/systemd/system/foodflow.service
systemctl daemon-reload
systemctl enable foodflow
chown -R www-data:www-data /var/www/foodflow
log_success "Systemd 服务配置完成"

# ===== 9. 启动服务 =====
log_info "启动服务..."
systemctl restart foodflow || true
sleep 5

if systemctl is-active --quiet foodflow; then
    log_success "服务启动成功！"
else
    log_error "服务启动失败，请查看日志：journalctl -u foodflow -n 50 --no-pager"
    log_warn "可能原因：数据库/Redis/NFS 配置不正确，请检查 /etc/foodflow/.env"
    exit 1
fi

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  部署完成！节点类型：$NODE_TYPE${NC}"
echo "=========================================="
echo ""
echo "应用目录：/var/www/foodflow"
echo "环境变量：/etc/foodflow/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
echo ""
if [ "$NODE_TYPE" == "master" ]; then
    log_info "主节点：定时任务已启用（自动备份、日志清理）"
else
    log_info "从节点：定时任务未启用（由主节点执行）"
fi
echo ""
log_warn "重要提示："
echo "  1. 请确保 /etc/foodflow/.env 中的数据库、Redis、NFS 配置正确"
echo "  2. 所有节点的数据库、Redis、NFS 配置必须完全相同"
echo "  3. 请配置 Nginx 负载均衡（参考 deploy/enterprise-ultimate/cluster/nginx.conf）"
echo "  4. 建议配置 SSL 证书"
echo "  5. 超级管理员后台: https://your-domain.com/super (默认 superadmin/super123)"
echo ""

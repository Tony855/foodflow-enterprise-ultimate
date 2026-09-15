#!/bin/bash
# ============================================================
# FoodFlow 本地一键安装脚本（无需拉取代码）
# 适用场景：代码已在当前目录，直接安装部署
#
# 使用方法：
#   cd /path/to/foodflow
#   sudo bash install-local.sh
#
# 支持系统：Debian 11+ / Ubuntu 20.04+
# ============================================================

set -e

# ===== 颜色输出 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ===== 检查 root 权限 =====
if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 权限运行：sudo bash $0"
    exit 1
fi

# 设置非交互模式，避免 apt 安装时弹出键盘布局等交互界面
export DEBIAN_FRONTEND=noninteractive

# ===== 获取当前目录 =====
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_info "应用目录: $APP_DIR"

# ===== 检查核心文件 =====
if [ ! -f "$APP_DIR/server.js" ]; then
    log_error "当前目录未找到 server.js，请确认在项目根目录下运行"
    exit 1
fi

if [ ! -f "$APP_DIR/package.json" ]; then
    log_error "当前目录未找到 package.json，请确认在项目根目录下运行"
    exit 1
fi

echo ""
echo "=========================================="
echo "  FoodFlow 本地一键安装"
echo "=========================================="
echo "应用目录: $APP_DIR"
echo "操作系统: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "=========================================="
echo ""

# ===== 1. 更新系统 =====
log_info "更新系统软件包..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git nginx build-essential
log_success "系统软件包更新完成"

# ===== 2. 安装 MariaDB =====
echo ""
log_info "检查数据库..."
DB_INSTALLED=false
if command -v mariadb &> /dev/null || command -v mysql &> /dev/null; then
    DB_INSTALLED=true
    log_success "MariaDB/MySQL 已安装"
else
    log_info "安装 MariaDB（兼容MySQL）..."
    apt-get install -y -qq mariadb-server
    systemctl enable mariadb
    systemctl start mariadb
    log_success "MariaDB 安装完成"
fi

# 确保数据库服务运行
systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true

# ===== 3. 安装 Redis =====
echo ""
log_info "检查 Redis..."
if command -v redis-server &> /dev/null; then
    log_success "Redis 已安装"
else
    log_info "安装 Redis..."
    apt-get install -y -qq redis-server
    systemctl enable redis-server
    systemctl start redis
    log_success "Redis 安装完成"
fi
systemctl start redis-server 2>/dev/null || true

# ===== 4. 安装 Node.js 20 LTS =====
echo ""
log_info "检查 Node.js..."
NODE_VERSION=0
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo 0)
fi

if [ "$NODE_VERSION" -lt 18 ]; then
    log_info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    log_success "Node.js 安装完成: $(node -v)"
else
    log_success "Node.js 已安装: $(node -v)"
fi

# ===== 5. 安装 npm 依赖 =====
echo ""
log_info "安装 Node.js 依赖..."
cd "$APP_DIR"
npm install --production --no-audit --no-fund
log_success "依赖安装完成"

# ===== 6. 创建必要目录 =====
echo ""
log_info "创建必要目录..."
mkdir -p "$APP_DIR"/{uploads,backups,logs}
mkdir -p /etc/foodflow
log_success "目录创建完成"

# ===== 7. 自动配置数据库和环境变量 =====
echo ""
log_info "自动配置数据库..."

# 7.1 数据库名（固定，不做不可靠的自动检测）
DEFAULT_DB_NAME="ordering_system"
log_info "数据库名: $DEFAULT_DB_NAME"

# 7.2 生成随机密码
DB_RANDOM_PASSWORD=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
JWT_RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

# 7.3 找到可用的 mysql 命令（处理 MariaDB unix_socket 认证）
MYSQL_CMD=""
if mariadb -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mariadb -u root"
elif mysql -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mysql -u root"
elif sudo mariadb -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="sudo mariadb -u root"
elif sudo mysql -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="sudo mysql -u root"
fi

if [ -z "$MYSQL_CMD" ]; then
    log_error "无法以 root 身份登录数据库，请检查 MariaDB 是否安装并启动"
    exit 1
fi

# 7.4 创建数据库（先删除旧的，确保干净）
log_info "创建数据库..."
$MYSQL_CMD -e "DROP DATABASE IF EXISTS \`$DEFAULT_DB_NAME\`;"
$MYSQL_CMD -e "CREATE DATABASE \`$DEFAULT_DB_NAME\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 7.5 创建数据库用户（先删除旧用户，确保密码正确）
log_info "创建数据库用户..."
$MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'localhost';"
$MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'127.0.0.1';"
$MYSQL_CMD -e "CREATE USER 'foodflow'@'localhost' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
$MYSQL_CMD -e "CREATE USER 'foodflow'@'127.0.0.1' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
$MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'localhost';"
$MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'127.0.0.1';"
$MYSQL_CMD -e "FLUSH PRIVILEGES;"

# 7.6 验证数据库连接（测试脚本写在项目目录下，才能找到node_modules）
log_info "验证数据库连接..."

# 写入测试脚本到项目目录（必须在项目目录才能找到 mysql2 模块）
cat > "$APP_DIR/db-test.js" << EOF
const mysql = require('mysql2/promise');
const conn = mysql.createConnection({
  host: '127.0.0.1', port: 3306,
  user: 'foodflow', password: '$DB_RANDOM_PASSWORD',
  database: '$DEFAULT_DB_NAME',
  connectTimeout: 5000
});
conn.then(c => { console.log('OK'); c.end(); process.exit(0); })
    .catch(e => { console.log('FAIL:', e.message); process.exit(1); });
EOF

# 在项目目录下执行，最多等10秒
cd "$APP_DIR"
if timeout 10 node db-test.js; then
    log_success "数据库和用户创建成功，连接测试通过"
else
    log_error "数据库连接测试失败，请检查 MariaDB 配置"
    rm -f "$APP_DIR/db-test.js"
    exit 1
fi
rm -f "$APP_DIR/db-test.js"

# 7.7 写入 .env 文件（始终覆盖）
ENV_FILE="$APP_DIR/.env"
log_info "写入环境变量配置..."

cat > "$ENV_FILE" << EOF
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DEFAULT_DB_NAME
DB_USER=foodflow
DB_PASSWORD=$DB_RANDOM_PASSWORD
DB_CONNECTION_LIMIT=50
REDIS_URL=
UPLOAD_DIR=./uploads
RUN_SCHEDULED_TASKS=true
JWT_SECRET=$JWT_RANDOM_SECRET
QR_DOMAIN=
EOF

chmod 600 "$ENV_FILE"
log_success ".env 配置文件已生成"

echo "  数据库配置:"
echo "    主机: 127.0.0.1"
echo "    数据库: $DEFAULT_DB_NAME"
echo "    用户: foodflow"
echo "    密码: ${DB_RANDOM_PASSWORD:0:4}****（完整密码见 .env 文件）"

# ===== 8. 停止旧服务，配置 Systemd =====
echo ""
log_info "配置 Systemd 服务..."

# 先停止并禁用旧服务（避免不断重启）
systemctl stop foodflow 2>/dev/null || true
systemctl disable foodflow 2>/dev/null || true
sleep 1

# 杀掉可能占用3000端口的进程
fuser -k 3000/tcp 2>/dev/null || true
sleep 1

NODE_PATH=$(which node)

cat > /etc/systemd/system/foodflow.service << EOF
[Unit]
Description=FoodFlow QR Ordering System
After=network.target mariadb.service mysql.service redis.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable foodflow
log_success "Systemd 服务配置完成"

# ===== 9. 配置 Nginx =====
echo ""
log_info "配置 Nginx..."
cat > /etc/nginx/conf.d/foodflow.conf << EOF
server {
    listen 80;
    server_name _;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
    }
}
EOF

# 测试并重载 Nginx
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log_success "Nginx 配置完成"
else
    log_warn "Nginx 配置测试失败，请手动检查 /etc/nginx/conf.d/foodflow.conf"
fi

# ===== 10. 启动服务 =====
echo ""
log_info "启动 FoodFlow 服务..."

systemctl restart foodflow || true
sleep 8

# 检查服务状态
if systemctl is-active --quiet foodflow; then
    log_success "FoodFlow 服务启动成功！"
else
    log_error "服务启动失败，最近日志："
    journalctl -u foodflow -n 40 --no-pager
    echo ""
    log_error "应用日志目录: $APP_DIR/logs/"
    exit 1
fi

# ===== 11. 健康检查 =====
echo ""
log_info "执行健康检查..."
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:3000/ 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "304" ]; then
    log_success "应用响应正常 (HTTP $HTTP_CODE)"
else
    log_warn "应用响应状态: HTTP $HTTP_CODE（可能需要等待初始化）"
fi

# 检查 Nginx
NGINX_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1/ 2>/dev/null || echo "000")
if [ "$NGINX_CODE" = "200" ] || [ "$NGINX_CODE" = "302" ]; then
    log_success "Nginx 代理正常 (HTTP $NGINX_CODE)"
else
    log_warn "Nginx 代理状态: HTTP $NGINX_CODE"
fi

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  安装完成！${NC}"
echo "=========================================="
echo ""
echo "应用目录:   $APP_DIR"
echo "环境变量:   $ENV_FILE"
echo "日志目录:   $APP_DIR/logs/"
echo "上传目录:   $APP_DIR/uploads/"
echo "备份目录:   $APP_DIR/backups/"
echo ""
echo "服务管理命令:"
echo "  启动: sudo systemctl start foodflow"
echo "  停止: sudo systemctl stop foodflow"
echo "  重启: sudo systemctl restart foodflow"
echo "  状态: sudo systemctl status foodflow"
echo "  日志: sudo journalctl -u foodflow -f"
echo "  应用日志: tail -f $APP_DIR/logs/server.log"
echo ""
echo "访问地址:"
echo "  本地: http://127.0.0.1"
echo "  外网: http://$(hostname -I | awk '{print $1}')"
echo ""
echo "默认账号:"
echo "  超级管理员: superadmin / super123"
echo "  商户管理员: admin / admin123"
echo ""
log_warn "重要提示："
echo "  1. 数据库已自动配置，密码保存在 $ENV_FILE（权限600）"
echo "  2. 请及时修改默认管理员密码"
echo "  3. 建议配置 SSL 证书: sudo bash setup-nginx.sh"
echo "  4. 服务日志: sudo journalctl -u foodflow -f"
echo ""

#!/usr/bin/env bash
# ============================================================
# FoodFlow Nginx 反向代理 + SSL 自动配置脚本
# 与 install-local.sh 完全兼容
#
# 使用方法：
#   cd /path/to/foodflow
#   sudo bash setup-nginx.sh
#
# 环境变量（可选，在 .env 中配置）：
#   DOMAIN=your-domain.com    域名（用于SSL证书）
#   EMAIL=your@email.com      邮箱（用于SSL证书续期提醒）
#   BACKEND_PORT=3000         后端端口（默认3000）
# ============================================================

set -e

# ===== 颜色输出 =====
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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

# 设置非交互模式
export DEBIAN_FRONTEND=noninteractive

# ===== 获取当前目录 =====
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
log_info "应用目录: $APP_DIR"

# ===== 读取 .env 配置 =====
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

DOMAIN="${DOMAIN:-${QR_DOMAIN:-}}"
EMAIL="${EMAIL:-admin@example.com}"
BACKEND_PORT="${PORT:-3000}"

# 后端端口不能是80/443
if [ "$BACKEND_PORT" = "80" ] || [ "$BACKEND_PORT" = "443" ]; then
    log_warn "BACKEND_PORT 不能设为 80/443，强制改为 3000"
    BACKEND_PORT=3000
fi

echo ""
echo "=============================================="
echo "  FoodFlow Nginx 配置 + SSL 证书"
echo "=============================================="
echo "应用目录: $APP_DIR"
echo "后端端口: $BACKEND_PORT"
echo "域名:     ${DOMAIN:-（未配置，仅HTTP）}"
echo "=============================================="
echo ""

# ===== 工具函数 =====
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 释放端口
kill_port() {
    local port=$1
    if command_exists fuser; then
        fuser -k ${port}/tcp 2>/dev/null || true
    fi
    if command_exists ss; then
        local pids=$(ss -lntp "sport = :${port}" 2>/dev/null | grep -Eo 'pid=[0-9]+' | grep -Eo '[0-9]+' | sort -u)
        for pid in $pids; do
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
    sleep 1
}

# ===== 1. 检查并安装 Nginx =====
log_info "检查 Nginx..."
if ! command_exists nginx; then
    log_info "安装 Nginx..."
    apt-get update -qq
    apt-get install -y -qq nginx
    log_success "Nginx 安装完成"
else
    log_success "Nginx 已安装"
fi

# ===== 2. 检查并安装 Certbot（用于SSL） =====
if [ -n "$DOMAIN" ]; then
    log_info "检查 Certbot..."
    if ! command_exists certbot; then
        log_info "安装 Certbot..."
        apt-get install -y -qq certbot python3-certbot-nginx 2>/dev/null || {
            log_warn "Certbot 安装失败，SSL 将不可用"
        }
    else
        log_success "Certbot 已安装"
    fi
fi

# ===== 3. 确保后端服务运行 =====
echo ""
log_info "检查后端服务..."
if systemctl list-unit-files 2>/dev/null | grep -q foodflow.service; then
    systemctl restart foodflow
    sleep 3
    if systemctl is-active --quiet foodflow; then
        log_success "后端服务运行正常 (端口 $BACKEND_PORT)"
    else
        log_error "后端服务启动失败，请检查: sudo journalctl -u foodflow -n 30"
        exit 1
    fi
else
    log_warn "未找到 foodflow systemd 服务，请先运行 install-local.sh"
    exit 1
fi

# ===== 4. 释放 80 端口 =====
echo ""
log_info "释放 80 端口..."
systemctl stop nginx 2>/dev/null || true
kill_port 80
log_success "80 端口已释放"

# ===== 5. 配置 Nginx HTTP =====
echo ""
log_info "配置 Nginx..."

NGINX_CONF="/etc/nginx/conf.d/foodflow.conf"

# 先删除可能存在的旧配置（sites-available 方式）
rm -f /etc/nginx/sites-enabled/dianchan 2>/dev/null || true
rm -f /etc/nginx/sites-available/dianchan 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 20M;

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# 测试 Nginx 配置
if ! nginx -t 2>&1; then
    log_error "Nginx 配置测试失败，请检查 $NGINX_CONF"
    exit 1
fi

# 启动 Nginx
systemctl start nginx
sleep 2

if systemctl is-active --quiet nginx; then
    log_success "Nginx HTTP 已启动"
else
    log_error "Nginx 启动失败，请检查: sudo nginx -t"
    exit 1
fi

# ===== 6. 申请 SSL 证书（如果配置了域名） =====
SSL_ENABLED=false
if [ -n "$DOMAIN" ] && command_exists certbot; then
    echo ""
    log_info "检查域名解析..."

    # 检查域名是否解析到本机
    SERVER_IP=$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s --connect-timeout 5 ipinfo.io/ip 2>/dev/null || echo "")
    DOMAIN_IP=""
    if command_exists host; then
        DOMAIN_IP=$(host "$DOMAIN" 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
    elif command_exists nslookup; then
        DOMAIN_IP=$(nslookup "$DOMAIN" 2>/dev/null | grep -A1 "Name:" | grep "Address:" | awk '{print $2}' | head -1 || echo "")
    fi

    if [ -n "$SERVER_IP" ] && [ -n "$DOMAIN_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
        log_warn "域名 $DOMAIN 解析到 $DOMAIN_IP，本机IP是 $SERVER_IP，SSL 申请可能失败"
    fi

    log_info "申请 SSL 证书（域名: $DOMAIN）..."
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect 2>&1; then
        SSL_ENABLED=true
        log_success "SSL 证书安装成功，已启用 HTTPS"
    else
        log_warn "Nginx 插件模式申请失败，尝试 standalone 模式..."
        systemctl stop nginx
        kill_port 80
        if certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" 2>&1; then
            log_success "证书获取成功，重新配置 Nginx..."

            cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20M;

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
            nginx -t && systemctl start nginx
            SSL_ENABLED=true
            log_success "HTTPS 已启用（standalone 模式）"
        else
            log_error "SSL 申请失败，仅 HTTP 可用"
            log_warn "请检查域名解析和防火墙（80端口需开放），然后手动运行:"
            echo "  sudo certbot --nginx -d $DOMAIN"
            systemctl start nginx
        fi
    fi
else
    if [ -z "$DOMAIN" ]; then
        log_warn "未配置域名，跳过 SSL（可在 .env 中设置 DOMAIN=your-domain.com）"
    else
        log_warn "Certbot 未安装，跳过 SSL"
    fi
fi

# ===== 7. 健康检查 =====
echo ""
log_info "健康检查..."
sleep 2

# 检查后端
BACKEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:${BACKEND_PORT}/ 2>/dev/null || echo "000")
if [ "$BACKEND_CODE" = "200" ] || [ "$BACKEND_CODE" = "302" ] || [ "$BACKEND_CODE" = "304" ]; then
    log_success "后端服务正常 (HTTP $BACKEND_CODE)"
else
    log_warn "后端服务状态: HTTP $BACKEND_CODE"
fi

# 检查 Nginx
NGINX_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1/ 2>/dev/null || echo "000")
if [ "$NGINX_CODE" = "200" ] || [ "$NGINX_CODE" = "302" ] || [ "$NGINX_CODE" = "301" ]; then
    log_success "Nginx 代理正常 (HTTP $NGINX_CODE)"
else
    log_warn "Nginx 代理状态: HTTP $NGINX_CODE"
fi

# ===== 完成 =====
echo ""
echo "=============================================="
echo -e "${GREEN}  配置完成！${NC}"
echo "=============================================="
echo ""
echo "Nginx 配置: $NGINX_CONF"
echo ""

if [ "$SSL_ENABLED" = true ]; then
    echo "访问地址:"
    echo "  HTTPS: https://${DOMAIN}"
    echo ""
    echo "SSL 证书:"
    echo "  证书路径: /etc/letsencrypt/live/${DOMAIN}/"
    echo "  自动续期: certbot 会自动续期（systemd timer）"
    echo "  手动续期: sudo certbot renew --dry-run"
else
    echo "访问地址:"
    echo "  HTTP: http://${DOMAIN:-$(hostname -I | awk '{print $1}')}"
    echo ""
    log_warn "SSL 未启用，启用方法:"
    echo "  1. 在 .env 中设置 DOMAIN=your-domain.com"
    echo "  2. 确保域名解析到本机IP"
    echo "  3. 确保防火墙开放 80 端口"
    echo "  4. 重新运行: sudo bash setup-nginx.sh"
fi

echo ""
echo "常用命令:"
echo "  测试配置: sudo nginx -t"
echo "  重载配置: sudo systemctl reload nginx"
echo "  查看日志: sudo tail -f /var/log/nginx/error.log"
echo ""

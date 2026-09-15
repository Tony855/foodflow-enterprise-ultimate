#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 一键安装脚本
# 支持：单台部署 / 2台服务器部署 / 多台服务器集群部署
# 用法：sudo bash install.sh
# ============================================================

set -e

# 设置非交互模式，避免 apt 安装时弹出键盘布局等交互界面
export DEBIAN_FRONTEND=noninteractive

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 日志函数
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }
log_success() { echo -e "${GREEN}${BOLD}[SUCCESS]${NC}${NC} $1"; }

# 脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/deploy"

# ============================================================
# 显示横幅
# ============================================================
show_banner() {
    clear 2>/dev/null || true
    echo -e "${PURPLE}${BOLD}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║   ███████╗ ██████╗  ██████╗ ██████╗ ███████╗██╗      ██╗   ██╗║"
    echo "║   ██╔════╝██╔═══██╗██╔═══██╗██╔══██╗██╔════╝██║      ██║   ██║║"
    echo "║   █████╗  ██║   ██║██║   ██║██║  ██║█████╗  ██║█████╗██║   ██║║"
    echo "║   ██╔══╝  ██║   ██║██║   ██║██║  ██║██╔══╝  ██║╚════╝╚██╗ ██╔╝║"
    echo "║   ██║     ╚██████╔╝╚██████╔╝██████╔╝██║     ██║       ╚████╔╝ ║"
    echo "║   ╚═╝      ╚═════╝  ╚═════╝ ╚═════╝ ╚═╝     ╚═╝        ╚═══╝  ║"
    echo "║                                                              ║"
    echo "║            多语言扫码点餐系统 - 一键安装向导                 ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
}

# ============================================================
# 检查root权限
# ============================================================
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "请使用 root 用户运行此脚本：sudo bash install.sh"
        exit 1
    fi
}

# ============================================================
# 检查系统
# ============================================================
check_system() {
    log_step "检查系统环境..."

    # 检查操作系统
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="$NAME"
        OS_VERSION="$VERSION_ID"
        log_info "操作系统：$OS_NAME $OS_VERSION"
    else
        log_error "无法识别操作系统，支持 Debian 11+ / Ubuntu 20.04+"
        exit 1
    fi

    # 检查是否为Debian/Ubuntu系
    if [ "$ID" != "debian" ] && [ "$ID" != "ubuntu" ]; then
        log_warn "当前系统为 $OS_NAME，建议使用 Debian 11+ 或 Ubuntu 20.04+"
        read -p "是否继续安装？(y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "安装已取消"
            exit 0
        fi
    fi

    # 检查架构
    ARCH=$(uname -m)
    log_info "系统架构：$ARCH"

    # 检查内存
    MEM_TOTAL=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo "未知")
    log_info "内存总量：${MEM_TOTAL}MB"

    # 检查磁盘
    DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')
    log_info "磁盘总量：$DISK_TOTAL"

    echo ""
}

# ============================================================
# 部署模式选择菜单
# ============================================================
select_deploy_mode() {
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}  请选择部署模式：${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}1. 标准版 - 单台部署${NC}"
    echo "     所有服务（Nginx + Node.js + MariaDB + Redis）在一台服务器"
    echo "     适用：1-50家门店，测试环境，小型餐饮企业"
    echo "     配置要求：2核4GB以上"
    echo ""
    echo -e "  ${BOLD}2. 企业版 - 2台服务器部署${NC}"
    echo "     双机负载均衡 + 共享数据库/Redis/NFS"
    echo "     适用：100-200家门店，中型餐饮连锁"
    echo "     配置要求：2台4核8GB应用服务器 + 独立MySQL/Redis"
    echo ""
    echo -e "  ${BOLD}3. 企业旗舰版 - 多台服务器集群部署${NC}"
    echo "     多节点负载均衡，可水平扩展，支持多商户/SaaS"
    echo "     适用：200+家门店，大型餐饮集团，SaaS平台"
    echo "     配置要求：3台以上8核16GB应用服务器 + 高可用MySQL/Redis"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    while true; do
        read -p "请输入选项 (1/2/3): " -n 1 -r
        echo
        case $REPLY in
            1)
                DEPLOY_MODE="standard"
                DEPLOY_NAME="标准版 - 单台部署"
                break
                ;;
            2)
                DEPLOY_MODE="enterprise"
                DEPLOY_NAME="企业版 - 2台服务器部署"
                break
                ;;
            3)
                DEPLOY_MODE="enterprise-ultimate"
                DEPLOY_NAME="企业旗舰版 - 多台服务器集群部署"
                break
                ;;
            *)
                log_warn "无效选项，请输入 1、2 或 3"
                ;;
        esac
    done

    echo ""
    log_info "已选择：${BOLD}$DEPLOY_NAME${NC}"
    echo ""
}

# ============================================================
# 节点角色选择（集群部署）
# ============================================================
select_node_role() {
    if [ "$DEPLOY_MODE" == "standard" ]; then
        NODE_ROLE="single"
        return
    fi

    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}  请选择当前服务器的角色：${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}1. 主节点 (Master)${NC}"
    echo "     执行定时任务（自动备份、日志清理）"
    echo "     第一台应用服务器选择此项"
    echo ""
    echo -e "  ${BOLD}2. 从节点 (Slave)${NC}"
    echo "     不执行定时任务，只处理业务请求"
    echo "     第二台及后续应用服务器选择此项"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    while true; do
        read -p "请输入选项 (1/2): " -n 1 -r
        echo
        case $REPLY in
            1)
                NODE_ROLE="master"
                break
                ;;
            2)
                NODE_ROLE="slave"
                break
                ;;
            *)
                log_warn "无效选项，请输入 1 或 2"
                ;;
        esac
    done

    echo ""
    log_info "节点角色：${BOLD}$NODE_ROLE${NC}"
    echo ""
}

# ============================================================
# 确认安装配置
# ============================================================
confirm_installation() {
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}${BOLD}  安装配置确认：${NC}"
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  部署模式：$DEPLOY_NAME"
    if [ "$DEPLOY_MODE" != "standard" ]; then
        echo "  节点角色：$NODE_ROLE"
    fi
    echo "  操作系统：$OS_NAME $OS_VERSION"
    echo "  系统架构：$ARCH"
    echo "  内存总量：${MEM_TOTAL}MB"
    echo "  磁盘总量：$DISK_TOTAL"
    echo ""
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    read -p "确认开始安装？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "安装已取消"
        exit 0
    fi
    echo ""
}

# ============================================================
# 单台部署
# ============================================================
install_single() {
    log_step "开始单台部署..."

    # 检查deploy目录是否存在
    if [ ! -d "$DEPLOY_DIR/standard" ]; then
        log_error "未找到标准版部署配置目录：$DEPLOY_DIR/standard"
        log_info "请确保 deploy 目录完整"
        exit 1
    fi

    # 检查部署脚本是否存在
    if [ ! -f "$DEPLOY_DIR/standard/deploy.sh" ]; then
        log_error "未找到标准版部署脚本：$DEPLOY_DIR/standard/deploy.sh"
        exit 1
    fi

    # 执行单台部署脚本
    log_info "执行标准版单台部署脚本..."
    bash "$DEPLOY_DIR/standard/deploy.sh"

    echo ""
    log_success "标准版单台部署完成！"
    echo ""
    echo "  应用目录：/var/www/foodflow"
    echo "  环境变量：/etc/foodflow/.env"
    echo "  服务管理：systemctl [start|stop|restart|status] foodflow"
    echo "  查看日志：journalctl -u foodflow -f"
    echo ""
    log_warn "请编辑 /etc/foodflow/.env 配置数据库密码等信息，然后重启服务"
    log_warn "建议配置SSL证书：sudo certbot --nginx -d your-domain.com"
}

# ============================================================
# 集群部署（标准版/企业版）
# ============================================================
install_cluster() {
    log_step "开始$DEPLOY_NAME..."

    # 确定部署目录
    if [ "$DEPLOY_MODE" == "enterprise" ]; then
        CLUSTER_DIR="$DEPLOY_DIR/enterprise/cluster"
    else
        CLUSTER_DIR="$DEPLOY_DIR/enterprise-ultimate/cluster"
    fi

    # 检查目录
    if [ ! -d "$CLUSTER_DIR" ]; then
        log_error "未找到部署配置目录：$CLUSTER_DIR"
        exit 1
    fi

    if [ ! -f "$CLUSTER_DIR/deploy.sh" ]; then
        log_error "未找到部署脚本：$CLUSTER_DIR/deploy.sh"
        exit 1
    fi

    # 执行集群部署脚本
    log_info "执行集群部署脚本（节点角色：$NODE_ROLE）..."
    bash "$CLUSTER_DIR/deploy.sh" "$NODE_ROLE"

    echo ""
    log_success "$DEPLOY_NAME完成！"
    echo ""
    echo "  部署模式：$DEPLOY_NAME"
    echo "  节点角色：$NODE_ROLE"
    echo "  应用目录：/var/www/foodflow"
    echo "  环境变量：/etc/foodflow/.env"
    echo "  服务管理：systemctl [start|stop|restart|status] foodflow"
    echo "  查看日志：journalctl -u foodflow -f"
    echo ""

    if [ "$NODE_ROLE" == "master" ]; then
        log_info "主节点：定时任务已启用（自动备份、日志清理）"
    else
        log_info "从节点：定时任务未启用（由主节点执行）"
    fi

    echo ""
    log_warn "请编辑 /etc/foodflow/.env 配置数据库、Redis、NFS等信息"
    log_warn "所有节点的数据库、Redis、NFS配置必须完全相同"
    log_warn "配置Nginx负载均衡：参考 $CLUSTER_DIR/nginx.conf"
}

# ============================================================
# 显示部署后指南
# ============================================================
show_post_install_guide() {
    echo ""
    echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║                    安装完成 - 后续步骤                     ║${NC}"
    echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if [ "$DEPLOY_MODE" == "standard" ]; then
        echo "  1. 编辑环境变量配置："
        echo "     sudo nano /etc/foodflow/.env"
        echo ""
        echo "  2. 重启服务使配置生效："
        echo "     sudo systemctl restart foodflow"
        echo ""
        echo "  3. 配置SSL证书（推荐）："
        echo "     sudo apt-get install certbot python3-certbot-nginx"
        echo "     sudo certbot --nginx -d your-domain.com"
        echo ""
        echo "  4. 访问系统："
        echo "     前台点餐：https://your-domain.com"
        echo "     商户后台：https://your-domain.com/admin"
        echo "     服务员端：https://your-domain.com/waiter"
        echo "     后厨端：  https://your-domain.com/kitchen"
        echo ""
    else
        echo "  1. 在所有应用服务器节点上编辑环境变量："
        echo "     sudo nano /etc/foodflow/.env"
        echo "     （所有节点的数据库、Redis、NFS配置必须相同）"
        echo ""
        echo "  2. 在所有节点上重启服务："
        echo "     sudo systemctl restart foodflow"
        echo ""
        echo "  3. 配置Nginx负载均衡（在Nginx服务器上）："
        echo "     参考部署目录中的 nginx.conf"
        echo "     sudo nginx -t && sudo systemctl reload nginx"
        echo ""
        echo "  4. 配置SSL证书："
        echo "     sudo certbot --nginx -d your-domain.com"
        echo ""
        echo "  5. 验证集群健康状态："
        echo "     curl -s http://节点1IP:3000/health"
        echo "     curl -s http://节点2IP:3000/health"
        echo ""
        if [ "$DEPLOY_MODE" == "enterprise-ultimate" ]; then
            echo "  6. 企业旗舰版超级管理员后台："
            echo "     https://your-domain.com/super"
            echo "     默认账号：superadmin / super123"
            echo "     （请尽快修改默认密码！）"
            echo ""
        fi
    fi

    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  常用命令："
    echo "    查看服务状态：sudo systemctl status foodflow"
    echo "    重启服务：    sudo systemctl restart foodflow"
    echo "    查看日志：    sudo journalctl -u foodflow -f"
    echo "    查看最近日志：sudo journalctl -u foodflow -n 100 --no-pager"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

# ============================================================
# 主函数
# ============================================================
main() {
    # 显示横幅
    show_banner

    # 检查root权限
    check_root

    # 检查系统环境
    check_system

    # 早期检查 deploy 目录是否完整
    if [ ! -d "$DEPLOY_DIR" ]; then
        log_error "未找到 deploy 目录：$DEPLOY_DIR"
        log_info "请确保从项目根目录运行此脚本，且 deploy 目录完整"
        exit 1
    fi

    # 选择部署模式
    select_deploy_mode

    # 选择节点角色（集群部署）
    select_node_role

    # 确认安装配置
    confirm_installation

    # 执行安装
    case $DEPLOY_MODE in
        standard)
            install_single
            ;;
        enterprise|enterprise-ultimate)
            install_cluster
            ;;
    esac

    # 显示部署后指南
    show_post_install_guide

    log_success "FoodFlow 点餐系统安装向导已完成！"
}

# 执行主函数
main "$@"

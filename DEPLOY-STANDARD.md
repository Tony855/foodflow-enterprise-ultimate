# FoodFlow 标准版部署指南

## 目录
1. [部署方式对比](#一部署方式对比)
2. [方式一：单服务器一键安装](#二方式一单服务器一键安装推荐)
3. [方式二：双服务器分离部署](#三方式二双服务器分离部署)
4. [核心配置说明](#四核心配置说明)
5. [常用管理命令](#五常用管理命令)
6. [默认账号](#六默认账号)

---

## 一、部署方式对比

| 部署方式 | 适用规模 | 架构 | 优点 |
|---------|---------|------|------|
| 单服务器 | 1-3家门店 | 应用+数据库同机 | 简单、成本低 |
| 双服务器分离 | 3-10家门店 | 应用服务器+数据库服务器 | 性能好、易扩展 |

---

## 二、方式一：单服务器一键安装（推荐）

### 系统要求
- Debian 11+ / Ubuntu 20.04+
- 2核CPU / 2GB内存 / 50GB SSD
- 固定公网IP或域名

### 安装步骤

```bash
# 1. 切换到root
sudo -i

# 2. 克隆标准版仓库
cd /opt
git clone https://github.com/Tony855/foodflow-standard.git
cd foodflow-standard

# 3. 运行一键安装
bash onekey-install.sh
```

脚本自动完成：
- ✅ Node.js 20+ 安装
- ✅ MySQL/MariaDB 安装（自动生成root密码）
- ✅ Redis 缓存安装
- ✅ 数据库创建（utf8mb4字符集）
- ✅ Node.js 依赖安装
- ✅ 数据库初始化（45道菜品+默认商户）
- ✅ systemd服务 + 开机自启

### 安装验证

```bash
systemctl status foodflow
curl http://localhost:3000/api/health
```

### Nginx 反向代理

```bash
apt install -y nginx

cat > /etc/nginx/sites-available/foodflow <<'EOF'
server {
    listen 80;
    server_name 你的域名或IP;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
EOF

ln -s /etc/nginx/sites-available/foodflow /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

---

## 三、方式二：双服务器分离部署

### 架构图

```
                    ┌─────────────┐
                    │   Nginx     │
                    │ (应用服务器)  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Node.js    │  应用服务器 (App Server)
                    │  应用服务    │  192.168.1.101
                    └──────┬──────┘
                           │ 内网连接
                    ┌──────▼──────┐
                    │   MySQL     │  数据库服务器 (DB Server)
                    │   Redis     │  192.168.1.102
                    └─────────────┘
```

### 服务器规划

| 服务器 | 配置 | 安装组件 | IP示例 |
|--------|------|---------|--------|
| 应用服务器 | 2核/4GB/50GB | Node.js + Nginx | 192.168.1.101 |
| 数据库服务器 | 2核/4GB/100GB | MySQL + Redis | 192.168.1.102 |

### 步骤1：数据库服务器配置

```bash
# 在数据库服务器(192.168.1.102)上执行
cd /opt
git clone https://github.com/Tony855/foodflow-standard.git
cd foodflow-standard

# 运行数据库服务器一键安装脚本
bash deploy-db-server.sh
```

脚本自动完成：
- ✅ MySQL 8.0 安装
- ✅ Redis 安装
- ✅ 配置MySQL远程访问
- ✅ 创建数据库和用户
- ✅ 配置防火墙（3306、6379端口）

### 步骤2：应用服务器配置

```bash
# 在应用服务器(192.168.1.101)上执行
cd /opt
git clone https://github.com/Tony855/foodflow-standard.git
cd foodflow-standard

# 运行应用服务器一键部署脚本
bash deploy-app-server.sh
```

脚本会提示输入：
- 数据库服务器IP（如：192.168.1.102）
- 数据库用户名（默认：foodflow）
- 数据库密码（部署数据库服务器时生成）

脚本自动完成：
- ✅ Node.js 20+ 安装
- ✅ Nginx 安装配置
- ✅ 连接远程数据库
- ✅ 初始化数据库
- ✅ systemd服务配置

### 步骤3：验证部署

```bash
# 在应用服务器上执行
curl http://localhost:3000/api/health

# 测试数据库连接
mysql -h 192.168.1.102 -u foodflow -p ordering_system -e "SELECT 1"
```

### 双服务器部署脚本说明

| 脚本 | 用途 | 运行位置 |
|------|------|---------|
| `deploy-db-server.sh` | 数据库服务器一键安装 | 数据库服务器 |
| `deploy-app-server.sh` | 应用服务器一键部署 | 应用服务器 |
| `DEPLOY-MULTI-SERVER.md` | 双服务器详细部署指南 | 参考文档 |

---

## 四、核心配置说明

编辑 `/opt/foodflow-standard/.env`：

```ini
# 服务配置
PORT=3000
NODE_ENV=production

# 数据库配置
DB_HOST=localhost          # 单服务器：localhost；双服务器：数据库IP
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_DATABASE=ordering_system

# Redis缓存
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_ENABLED=true

# 性能配置
DB_CONNECTION_LIMIT=20
BODY_LIMIT=50mb
```

修改后重启：
```bash
systemctl restart foodflow
```

---

## 五、常用管理命令

```bash
# 服务管理
systemctl start foodflow
systemctl stop foodflow
systemctl restart foodflow
systemctl status foodflow

# 日志查看
journalctl -u foodflow -f
journalctl -u foodflow --lines 100

# 数据库备份
mysqldump -u root -p ordering_system > /opt/backup_$(date +%Y%m%d).sql

# 数据库恢复
mysql -u root -p ordering_system < backup.sql

# 重新初始化数据库（危险！清空所有数据）
bash reinstall-db.sh
```

### 防火墙配置

```bash
# 单服务器
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 22/tcp
ufw enable

# 数据库服务器（额外开放）
ufw allow from 192.168.1.101 to any port 3306
ufw allow from 192.168.1.101 to any port 6379
```

---

## 六、默认账号

| 角色 | 账号 | 密码 | 登录地址 |
|------|------|------|---------|
| 商户管理员 | `admin` | `admin123` | `/login` |
| 服务员 | 后台创建 | 后台设置 | `/waiter` |

> ⚠️ 首次登录后请立即修改密码！

### 访问地址

| 页面 | 地址 | 说明 |
|------|------|------|
| 商户后台 | `/login` | 店铺、菜品、订单管理 |
| 顾客点餐 | `/` | 扫码进入，无需登录 |
| 服务员端 | `/waiter` | 接单、上菜 |
| 后厨端 | `/kitchen` | 后厨订单显示 |

### 初始数据说明

首次安装自动初始化（仅首次，重启不覆盖）：
- **菜品**: 45道烧腊菜品，8个分类（默认全部下架）
- **货币**: USD/CNY/KHR/THB/VND（默认USD，第二货币KHR）
- **桌台**: 12个（A01-A04, B01-B04, C01-C04）
- **店铺**: 1个（总店）

---

*文档版本: v1.0 | 更新日期: 2026-09-13*

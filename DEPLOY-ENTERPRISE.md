# FoodFlow 企业版部署指南

## 目录
1. [部署方式对比](#一部署方式对比)
2. [方式一：一键安装（单服务器）](#二方式一一键安装单服务器推荐)
3. [方式二：Docker Compose 部署](#三方式二docker-compose-部署)
4. [方式三：Kubernetes 集群部署](#四方式三kubernetes-集群部署)
5. [企业版核心配置](#五企业版核心配置)
6. [常用管理命令](#六常用管理命令)
7. [从标准版升级](#七从标准版升级到企业版)
8. [默认账号](#八默认账号)

---

## 一、部署方式对比

| 部署方式 | 适用规模 | 日订单量 | 并发能力 | 运维难度 |
|---------|---------|---------|---------|---------|
| 一键安装 | 1-5家门店 | <5000单 | ~500人 | 低 |
| Docker Compose | 5-20家门店 | 5000-20000单 | ~2000人 | 中 |
| Kubernetes | 20+门店 | 20000+单 | 10000+人 | 高 |

---

## 二、方式一：一键安装（单服务器，推荐）

### 系统要求
- Debian 11+ / Ubuntu 20.04+
- 2核CPU / 4GB内存 / 50GB SSD（推荐4核/8GB）
- 固定公网IP或域名

### 安装步骤

```bash
# 1. 切换到root
sudo -i

# 2. 克隆企业版仓库
cd /opt
git clone https://github.com/Tony855/foodflow-enterprise.git
cd foodflow-enterprise

# 3. 运行一键安装
bash onekey-install.sh
```

脚本自动完成：
- ✅ Node.js 20+ 安装
- ✅ MySQL/MariaDB 安装（自动生成root密码）
- ✅ Redis 缓存安装
- ✅ 数据库创建（utf8mb4字符集）
- ✅ Node.js 依赖安装
- ✅ 数据库初始化（超级管理员+默认商户）
- ✅ Cluster多进程配置
- ✅ systemd服务 + 开机自启

### 安装验证

```bash
# 服务状态
systemctl status foodflow

# 健康检查
curl http://localhost:3000/api/health

# 查看日志
journalctl -u foodflow -f
```

### Nginx 反向代理配置

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
        proxy_set_header X-Forwarded-Proto $scheme;
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

### HTTPS 配置

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

---

## 三、方式二：Docker Compose 部署

### 系统要求
- Docker + Docker Compose
- 2核CPU / 4GB内存 / 100GB SSD

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/Tony855/foodflow-enterprise.git
cd foodflow-enterprise

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，修改 DB_PASSWORD、SESSION_SECRET

# 3. 启动服务
docker-compose up -d

# 4. 查看状态
docker-compose ps
docker-compose logs -f app
```

### 包含的服务

| 服务 | 端口 | 说明 |
|------|------|------|
| app | 3000 | Node.js应用（Cluster多进程） |
| mysql | 3306 | MySQL 8.0 数据库 |
| redis | 6379 | Redis 缓存 |
| nginx | 80/443 | Nginx反向代理 |

---

## 四、方式三：Kubernetes 集群部署

### 架构图

```
CDN/WAF → Ingress(HTTPS) → App Pods(3-20自动伸缩)
                              ↓
                    Redis集群(6节点) + RabbitMQ + MySQL主从
                              ↓
                    Prometheus监控 + Grafana仪表盘
```

### 部署步骤

```bash
# 1. 创建命名空间
kubectl create namespace foodflow

# 2. 创建密钥
kubectl create secret generic foodflow-secrets \
  --namespace foodflow \
  --from-literal=db-password='你的数据库密码' \
  --from-literal=session-secret='随机字符串'

# 3. 部署基础设施
kubectl apply -f k8s/redis-cluster.yaml
kubectl apply -f k8s/rabbitmq.yaml
kubectl apply -f k8s/configmap.yaml

# 4. 部署应用（含HPA自动伸缩）
kubectl apply -f k8s/deployment.yaml

# 5. 部署监控
kubectl apply -f monitoring/prometheus.yaml
kubectl apply -f monitoring/grafana.yaml

# 6. 查看状态
kubectl get all -n foodflow
kubectl get hpa -n foodflow
```

### K8s 企业版特性

| 特性 | 说明 |
|------|------|
| 自动伸缩 | HPA根据CPU/内存自动扩缩容（3-20实例） |
| 零停机 | 滚动更新，发布不中断服务 |
| 健康检查 | 存活/就绪探针，异常自动重启 |
| Redis集群 | 6节点（3主3从），高可用缓存 |
| 消息队列 | RabbitMQ异步处理订单，削峰填谷 |
| 监控告警 | Prometheus + Grafana可视化 |

---

## 五、企业版核心配置

编辑 `/opt/foodflow-enterprise/.env`：

```ini
# ===== 服务配置 =====
NODE_ENV=production
PORT=3000

# ===== 数据库配置 =====
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=ordering_system
DB_CONNECTION_LIMIT=50

# ===== Redis缓存配置 =====
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_ENABLED=true

# ===== Cluster多进程（企业版特性） =====
CLUSTER_ENABLED=true
CLUSTER_WORKERS=0  # 0=自动根据CPU核心数

# ===== 性能配置 =====
BODY_LIMIT=50mb
REQUEST_TIMEOUT=10000

# ===== 会话密钥（生产环境务必修改） =====
SESSION_SECRET=change_this_to_a_random_secret_key
```

修改后重启：
```bash
systemctl restart foodflow
```

---

## 六、常用管理命令

```bash
# 服务管理
systemctl start foodflow
systemctl stop foodflow
systemctl restart foodflow
systemctl status foodflow

# 日志查看
journalctl -u foodflow -f
journalctl -u foodflow --lines 100

# 进程查看（Cluster多进程）
ps aux | grep node

# 数据库备份
mysqldump -u root -p ordering_system > /opt/backup_$(date +%Y%m%d).sql

# 数据库恢复
mysql -u root -p ordering_system < backup.sql

# 重新初始化数据库（危险！清空所有数据）
bash reinstall-db.sh
```

### 防火墙配置

```bash
# UFW
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 22/tcp
ufw enable

# firewalld
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

---

## 七、从标准版升级到企业版

```bash
# 1. 备份标准版数据库
mysqldump -u root -p ordering_system > /opt/standard_backup.sql

# 2. 停止标准版服务
systemctl stop foodflow

# 3. 安装企业版
cd /opt
git clone https://github.com/Tony855/foodflow-enterprise.git
cd foodflow-enterprise
npm install --omit=dev

# 4. 复制标准版配置
cp /opt/foodflow-standard/.env .env

# 5. 添加企业版配置
echo "CLUSTER_ENABLED=true" >> .env
echo "REDIS_ENABLED=true" >> .env

# 6. 启动企业版
systemctl restart foodflow
```

---

## 八、默认账号

| 角色 | 账号 | 密码 | 登录地址 |
|------|------|------|---------|
| 超级管理员 | `superadmin` | `super123` | `/super` |
| 商户管理员 | `admin` | `admin123` | `/login` |
| 服务员 | 后台创建 | 后台设置 | `/waiter` |

> ⚠️ 首次登录后请立即修改密码！

### 访问地址

| 页面 | 地址 | 说明 |
|------|------|------|
| 超级管理员 | `/super` | 商户管理、全局配置 |
| 商户后台 | `/login` | 店铺、菜品、订单管理 |
| 顾客点餐 | `/` | 扫码进入，无需登录 |
| 服务员端 | `/waiter` | 接单、上菜 |
| 后厨端 | `/kitchen` | 后厨订单显示 |

---

## 企业版 vs 标准版

| 功能 | 标准版 | 企业版 |
|------|--------|--------|
| 单商户管理 | ✅ | ✅ |
| 超级管理员+多商户 | ❌ | ✅ |
| 门店数量限制 | 硬编码 | 超级管理员可配置 |
| Node.js多进程 | ❌ | ✅ Cluster模式 |
| Redis缓存 | 可选 | ✅ 必需 |
| Docker部署 | ❌ | ✅ |
| K8s集群部署 | ❌ | ✅ |
| 监控告警 | 基础 | ✅ Prometheus+Grafana |
| 消息队列 | ❌ | ✅ RabbitMQ |
| 并发能力 | ~500同时在线 | 10000+同时在线 |

---

*文档版本: v1.0 | 更新日期: 2026-09-13*

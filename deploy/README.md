# FoodFlow 部署配置

本目录包含 FoodFlow 点餐系统的部署配置，按版本分类。

---

## 目录结构

```
deploy/
├── README.md                        # 本文件（总览）
│
├── standard/                        # 📦 标准版 - 单台部署
│   ├── README.md                    # 标准版部署详细指南
│   ├── deploy.sh                    # 一键部署脚本
│   ├── nginx.conf                   # Nginx反向代理配置
│   ├── foodflow.service             # Systemd服务配置
│   └── .env.example                 # 环境变量模板
│
├── enterprise/                      # 🏢 企业版 - 2台服务器部署
│   ├── README.md                    # 企业版部署详细指南
│   └── cluster/                     # 2台服务器双机负载均衡
│       ├── deploy.sh                # 部署脚本（master/slave）
│       ├── nginx.conf               # Nginx负载均衡配置（2节点）
│       ├── foodflow.service         # Systemd服务配置
│       ├── .env.example             # 环境变量模板
│       ├── init-db.sh               # 数据库初始化脚本
│       └── setup-nfs-server.sh      # NFS共享存储配置
│
└── enterprise-ultimate/             # 👑 企业旗舰版 - 多台服务器集群
    ├── README.md                    # 企业旗舰版部署详细指南 + 水平扩展
    └── cluster/                     # 多台服务器集群（可水平扩展）
        ├── deploy.sh                # 部署脚本（master/slave）
        ├── nginx.conf               # Nginx负载均衡配置（3节点起）
        ├── foodflow.service         # Systemd服务配置（更高资源）
        ├── .env.example             # 环境变量模板（含旗舰版特有配置）
        ├── init-db.sh               # 数据库初始化脚本
        └── setup-nfs-server.sh      # NFS共享存储配置
```

---

## 版本对比

| 对比项 | 标准版 Standard | 企业版 Enterprise | 企业旗舰版 Enterprise Ultimate |
|--------|----------------|------------------|-------------------------------|
| **部署模式** | 单台服务器 | 2台服务器 | 多台服务器集群 |
| **定位** | 小型餐饮企业 | 中型餐饮连锁 | 大型餐饮集团/SaaS平台 |
| **适用规模** | 1-50家门店 | 100-200家门店 | 200+家门店 |
| **应用服务器** | 1台（所有服务） | 2台（固定） | 3台起（可水平扩展） |
| **并发能力** | ~500同时在线 | ~3,000同时在线 | 5,000+（可扩展） |
| **高可用性** | ❌ 单点故障 | ✅ 应用层无单点 | ✅ 全栈高可用 |
| **超级管理员后台** | ❌ | ❌ | ✅ |
| **多商户管理** | ❌ | ❌ | ✅ |
| **商户数据隔离** | 单商户 | 单商户 | 多商户严格隔离 |
| **商户编码自动生成** | ❌ | ❌ | ✅ |
| **操作审计日志** | ❌ | ❌ | ✅ |
| **登录日志** | ❌ | ❌ | ✅ |
| **商户自助注册** | ❌ | ❌ | ✅（可配置） |
| **数据库名** | foodflow_standard | foodflow_enterprise | foodflow_enterprise_ultimate |
| **GitHub仓库** | foodflow-standard | foodflow-enterprise | foodflow-enterprise |
| **配置要求** | 2核4GB | 2台4核8GB + 独立DB/Redis | 3台以上8核16GB + 高可用DB/Redis |

---

## 如何选择？

### 选择标准版（单台部署），如果：
- 你是小型餐饮企业，门店数量在1-50家
- 预算有限，需要最高性价比方案
- 技术团队规模较小，运维能力有限
- 测试环境或演示环境使用
- 可以接受单点故障（有备份即可）

### 选择企业版（2台服务器），如果：
- 你是中型餐饮连锁企业，门店数量在100-200家
- 需要应用层高可用，避免单点故障
- 业务量增长，单台服务器性能不足
- 有独立的数据库和Redis服务器
- 有基本的运维能力

### 选择企业旗舰版（多台服务器集群），如果：
- 你是大型餐饮集团或SaaS平台，门店数量200+
- 需要管理多个独立商户/品牌
- 需要超级管理员统一后台
- 需要完整的审计日志和合规能力
- 需要水平扩展能力应对业务快速增长
- 有专业的运维团队

---

## 快速开始

### 使用一键安装脚本（推荐）

```bash
# 1. 下载或克隆代码到服务器
git clone https://github.com/Tony855/foodflow-standard.git
cd foodflow-standard

# 2. 运行一键安装脚本
sudo bash install.sh

# 3. 按照向导选择部署模式：
#    1. 标准版 - 单台部署
#    2. 企业版 - 2台服务器部署
#    3. 企业旗舰版 - 多台服务器集群部署
```

### 手动部署

#### 标准版（单台部署）
```bash
sudo bash deploy/standard/deploy.sh
```

#### 企业版（2台服务器）
```bash
# 1. 配置NFS
sudo bash deploy/enterprise/cluster/setup-nfs-server.sh

# 2. 初始化数据库
sudo bash deploy/enterprise/cluster/init-db.sh

# 3. 部署主节点
sudo bash deploy/enterprise/cluster/deploy.sh master

# 4. 部署从节点
sudo bash deploy/enterprise/cluster/deploy.sh slave

# 5. 配置Nginx
sudo cp deploy/enterprise/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

#### 企业旗舰版（多台服务器集群）
```bash
# 1. 配置NFS
sudo bash deploy/enterprise-ultimate/cluster/setup-nfs-server.sh

# 2. 初始化数据库
sudo bash deploy/enterprise-ultimate/cluster/init-db.sh

# 3. 部署主节点
sudo bash deploy/enterprise-ultimate/cluster/deploy.sh master

# 4. 部署从节点（可重复部署N台）
sudo bash deploy/enterprise-ultimate/cluster/deploy.sh slave

# 5. 配置Nginx
sudo cp deploy/enterprise-ultimate/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 版本升级路线

```
标准版（单台）
    │
    │  业务增长，需要高可用
    ▼
企业版（2台服务器）
    │
    │  多商户管理需求，需要水平扩展
    ▼
企业旗舰版（多台服务器集群）
```

### 从标准版升级到企业版
1. 准备第二台应用服务器
2. 准备独立的MySQL和Redis服务器
3. 准备NFS共享存储
4. 迁移数据库和上传文件
5. 部署2台应用服务器节点
6. 配置Nginx负载均衡
7. 切换DNS，下线旧服务器

### 从企业版升级到企业旗舰版
1. 准备第三台及更多应用服务器
2. 升级MySQL到高可用版
3. 升级Redis到主从/集群模式
4. 启用超级管理员后台
5. 配置多商户管理
6. 水平扩展应用服务器节点

---

## 技术支持

- 标准版部署问题：查看 `deploy/standard/README.md`
- 企业版部署问题：查看 `deploy/enterprise/README.md`
- 企业旗舰版部署问题：查看 `deploy/enterprise-ultimate/README.md`
- 日志排查：`journalctl -u foodflow -f`
- Nginx日志：`tail -f /var/log/nginx/error.log`

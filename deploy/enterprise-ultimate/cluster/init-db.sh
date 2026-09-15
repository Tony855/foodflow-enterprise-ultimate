#!/bin/bash
# ============================================================
# FoodFlow 企业版 - 数据库初始化脚本
# 适用：多商户/SaaS平台
# ============================================================
set -e

DB_HOST="mysql-enterprise.example.com"
DB_PORT="3306"
DB_ROOT_USER="root"
DB_ROOT_PASS="YourRootPassword"
DB_NAME="foodflow_enterprise_ultimate"
DB_USER="foodflow"
DB_PASS="YourStrongPasswordHere"

echo "=========================================="
echo "FoodFlow 企业版 - 数据库初始化"
echo "=========================================="

# 创建数据库
mysql -h$DB_HOST -P$DB_PORT -u$DB_ROOT_USER -p$DB_ROOT_PASS <<EOF
CREATE DATABASE IF NOT EXISTS $DB_NAME
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'%';
FLUSH PRIVILEGES;
EOF

echo "数据库和用户创建完成"

# 执行应用初始化（创建表和默认数据）
cd /var/www/foodflow
DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_PASSWORD=$DB_PASS DB_NAME=$DB_NAME INIT_ONLY=true node server.js || true

echo ""
echo "=========================================="
echo "企业版数据库初始化完成！"
echo "=========================================="
echo "数据库：$DB_NAME"
echo "默认超级管理员：superadmin / super123"
echo "请尽快修改默认密码！"

#!/bin/bash
# ============================================================
# FoodFlow - NFS 共享存储服务器配置
# 适用：标准版和企业版集群部署
# 作用：共享菜品图片上传目录
# ============================================================

set -e

echo "=========================================="
echo "NFS 共享存储服务器配置"
echo "=========================================="

# 安装NFS服务
apt-get update -qq
apt-get install -y -qq nfs-kernel-server

# 创建共享目录
mkdir -p /export/uploads
chown nobody:nogroup /export/uploads
chmod 777 /export/uploads

# 配置NFS导出（请根据实际网络修改IP段）
cat > /etc/exports <<'EOF'
# FoodFlow 上传目录共享
/export/uploads  192.168.1.0/24(rw,sync,no_subtree_check,no_root_squash)
EOF

# 重启NFS服务
exportfs -a
systemctl restart nfs-kernel-server
systemctl enable nfs-kernel-server

# 防火墙配置
if command -v ufw &> /dev/null; then
    ufw allow from 192.168.1.0/24 to any port nfs
    ufw allow from 192.168.1.0/24 to any port 2049
fi

echo ""
echo "=========================================="
echo "NFS 服务器配置完成！"
echo "=========================================="
echo "共享目录：/export/uploads"
echo ""
echo "在应用服务器上挂载："
echo "  sudo mkdir -p /mnt/shared/uploads"
echo "  sudo mount -t nfs NFS_SERVER_IP:/export/uploads /mnt/shared/uploads"
echo ""
echo "开机自动挂载（添加到 /etc/fstab）："
echo "  NFS_SERVER_IP:/export/uploads /mnt/shared/uploads nfs defaults,_netdev 0 0"

#!/bin/bash
# Setup systemd services for all microservices on Hetzner
DIR="/opt/tak25-branch-bank"

for svc in central-bank-service user-service account-service transfer-service gateway; do
  case $svc in
    central-bank-service) PORT_VAR="CB_PORT=8085"; DB_VAR="CB_DB_PATH=$DIR/data/central-bank-service.db" ;;
    user-service) PORT_VAR="USER_PORT=8082"; DB_VAR="USER_DB_PATH=$DIR/data/user-service.db" ;;
    account-service) PORT_VAR="ACCOUNT_PORT=8083"; DB_VAR="ACCOUNT_DB_PATH=$DIR/data/account-service.db" ;;
    transfer-service) PORT_VAR="TRANSFER_PORT=8084"; DB_VAR="TRANSFER_DB_PATH=$DIR/data/transfer-service.db" ;;
    gateway) PORT_VAR="PORT=8081"; DB_VAR="" ;;
  esac

  cat > /etc/systemd/system/bank-$svc.service << EOF
[Unit]
Description=TAK25 $svc
After=network.target
$([ "$svc" != "central-bank-service" ] && echo "After=bank-central-bank-service.service")

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
Environment=$PORT_VAR
$([ -n "$DB_VAR" ] && echo "Environment=$DB_VAR")
ExecStart=/usr/bin/node --import tsx src/$svc/server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable bank-$svc
  echo "Created bank-$svc.service"
done

# Stop old monolith service
systemctl stop branch-bank 2>/dev/null
systemctl disable branch-bank 2>/dev/null

# Start services in order
systemctl start bank-central-bank-service
sleep 3
systemctl start bank-user-service
systemctl start bank-account-service
systemctl start bank-transfer-service
sleep 2
systemctl start bank-gateway

echo ""
echo "All services started. Checking health..."
sleep 3
curl -s http://localhost:8081/health

#!/bin/bash
# Start all microservices
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Starting TAK25 Branch Bank microservices..."

# Start services in background
npx tsx src/central-bank-service/server.ts &
PID_CB=$!
sleep 2

npx tsx src/user-service/server.ts &
PID_USER=$!

npx tsx src/account-service/server.ts &
PID_ACCOUNT=$!

npx tsx src/transfer-service/server.ts &
PID_TRANSFER=$!

sleep 2

npx tsx src/gateway/server.ts &
PID_GATEWAY=$!

echo ""
echo "All services started:"
echo "  Central Bank Service: port 8085 (PID $PID_CB)"
echo "  User Service:         port 8082 (PID $PID_USER)"
echo "  Account Service:      port 8083 (PID $PID_ACCOUNT)"
echo "  Transfer Service:     port 8084 (PID $PID_TRANSFER)"
echo "  API Gateway:          port 8081 (PID $PID_GATEWAY)"
echo ""
echo "API:        http://localhost:8081"
echo "Swagger UI: http://localhost:8081/docs"
echo ""

cleanup() {
  echo "Stopping all services..."
  kill $PID_CB $PID_USER $PID_ACCOUNT $PID_TRANSFER $PID_GATEWAY 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

wait

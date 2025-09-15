#!/bin/bash

# CPU 사용량 모니터링 스크립트
# Usage: ./tools/monitor-cpu.sh [스트림개수]

STREAM_COUNT=${1:-1}
echo "🔍 ${STREAM_COUNT}개 스트림 CPU 모니터링 시작..."

# 초기 CPU 측정
echo "📊 초기 CPU 사용량:"
top -l 1 | grep "CPU usage"

# 스트림 상태 확인
echo "📋 스트림 상태:"
curl -s "http://localhost:8080/catalog?count=${STREAM_COUNT}" | jq '.streams | length' | xargs -I {} echo "스트림 개수: {}"

# 활성 스트림 확인
echo "🎬 활성 스트림:"
curl -s http://localhost:8080/stream-limit | jq '.activeStreams' 2>/dev/null || echo "API 응답 오류"

# 5초 후 CPU 재측정
echo "⏱️ 5초 후 CPU 사용량:"
sleep 5
top -l 1 | grep "CPU usage"

echo "✅ 모니터링 완료"

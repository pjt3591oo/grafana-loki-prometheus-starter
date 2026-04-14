# Observable — Grafana + Prometheus + Loki 관측성 스택 데모

Node.js 애플리케이션의 **메트릭**과 **로그**를 각각 Prometheus / Loki로 수집하고, Grafana로 통합 시각화하는 Docker Compose 기반 데모입니다.

---

## 1. 전체 구조

```
┌────────────────────────────────────────────────────────────────────┐
│                    Docker Compose Network                          │
│                                                                    │
│   ┌────────────────────────────────────────┐                       │
│   │          app  (Node.js)  :3000         │                       │
│   │                                        │                       │
│   │   prom-client ──▶ /metrics (HTTP) ─────┼──┐ (1) pull (15s)     │
│   │   winston     ──▶ stdout          ─────┼──┼──┐                 │
│   └────────────────────────────────────────┘  │  │                 │
│                                               │  │                 │
│            /var/lib/docker/containers/...◀────┼──┘  (docker        │
│                   <id>-json.log               │   json-file driver)│
│                         │                     │                    │
│                         │ tail                │                    │
│                         ▼                     │                    │
│                  ┌───────────────┐            │                    │
│                  │   Promtail    │            │                    │
│                  │ Docker SD +   │            │                    │
│                  │ relabel+push  │            │                    │
│                  └───────┬───────┘            │                    │
│                          │ (2) push           │                    │
│                          ▼                    ▼                    │
│                   ┌────────────┐       ┌──────────────┐            │
│                   │    Loki    │       │  Prometheus  │            │
│                   │   :3100    │       │    :9090     │            │
│                   └──────┬─────┘       └──────┬───────┘            │
│                          │ LogQL              │ PromQL             │
│                          └──────────┬─────────┘                    │
│                                     ▼                              │
│                          ┌────────────────────┐                    │
│                          │      Grafana       │                    │
│                          │       :3001        │                    │
│                          └────────────────────┘                    │
└────────────────────────────────────────────────────────────────────┘
```

**핵심 원칙**
- **메트릭 = Pull**: Prometheus가 app의 **`/metrics` HTTP 엔드포인트를 직접** 주기적으로 긁어감 (stdout/파일과 무관)
- **로그 = Push**: winston이 stdout에 출력 → Docker json-file 드라이버가 파일로 저장 → Promtail이 tail → Loki로 push
- app 내부에서 **메트릭과 로그는 서로 독립된 두 출구**(prom-client 메모리 / winston stdout)를 가짐

---

## 2. 구성 요소별 역할

| 서비스 | 포트 | 역할 |
|--------|------|------|
| **app** | 3000 | Express 서버. `/`, `/slow`, `/error`, `/metrics` 엔드포인트. winston으로 JSON 로그를 stdout에 출력 |
| **prometheus** | 9090 | 15초마다 `app:3000/metrics`를 스크레이프하는 시계열 DB + PromQL 엔진 |
| **loki** | 3100 | 로그 저장소 + LogQL 엔진. **외부에서 push 받는 모델** |
| **promtail** | — | Docker 로그 수집 에이전트. `docker.sock`으로 컨테이너 탐지 → 라벨링 → Loki push |
| **grafana** | 3001 | Prometheus + Loki를 데이터소스로 쓰는 시각화 UI (프로비저닝 자동 설정) |

---

## 3. Promtail의 역할

**Promtail = Loki 전용 로그 수집 에이전트.** Loki는 스스로 로그를 긁지 않고 push만 받으므로, "로그 발견 → 라벨링 → 전송" 담당이 필요합니다.

이 프로젝트에서는:
1. `docker.sock`으로 컨테이너 자동 탐지 (`docker_sd_configs`, 5초마다 갱신)
2. 각 컨테이너의 `*-json.log` 파일을 tail
3. 메타데이터를 라벨로 변환: `container`, `service`, `logstream`
4. `http://loki:3100/loki/api/v1/push`로 배치 전송
5. `/tmp/positions.yaml`에 오프셋 저장 → 재시작 시 이어서 수집

### Promtail이 지원하는 입력 소스
- ✅ 로컬 파일, Docker, Kubernetes, systemd journal, syslog, Kafka, Windows Event Log, GCP Cloud Logging
- ❌ AWS CloudWatch, Datadog, Splunk 같은 SaaS REST API 직접 호출 불가
- ⚠️ **Promtail은 2026년 2월 EOL 예정** → Grafana Alloy로 이전 권장

---

## 4. Winston 로그의 실제 저장 경로

현재 winston은 `Console` 트랜스포트만 사용 → 파일이 아니라 **stdout**으로만 출력.
Docker의 **json-file 드라이버**가 stdout을 가로채 저장:

```
/var/lib/docker/containers/<container-id>/<container-id>-json.log
```

- 한 줄당 JSON: `{"log":"...","stream":"stdout","time":"..."}`
- `max-size: 10m`, `max-file: 3` → 총 30MB 롤링
- macOS(Docker Desktop)에서는 LinuxVM 내부라 `docker logs <container>`로 확인
- Promtail이 바로 이 파일을 tail함

---

## 5. 외부 시스템 연동 패턴

### 5-1. MongoDB Atlas (managed DB)

Atlas는 주로 **메트릭**이 관심 대상이므로 **Prometheus**가 정답.

**메트릭**
- Atlas UI → Project Settings → **Integrations → Prometheus** (공식 제공)
- `scrape_configs`에 Atlas가 준 URL/토큰을 꽂으면 바로 수집
- CPU, opcounters, connections, replication lag 등 노출

**로그** (필요 시)
- Slow Query / Audit 로그를 **S3 / CloudWatch로 export** → Alloy/Vector → Loki
- "지연시간 스파이크 난 순간 어떤 쿼리였나?" 같은 상관 분석 때 유용

### 5-2. AWS CloudWatch 통합 수집

EC2뿐 아니라 **Lambda, ECS, API Gateway** 등은 에이전트 설치가 불가능 → **CloudWatch로 로그가 모인 뒤 한 번에 Loki로** 보내는 것이 표준.

```
각종 AWS 리소스 ──▶ CloudWatch Logs ──▶ [수집기] ──▶ Loki
```

수집기 선택지:

| 방식 | 특징 |
|------|------|
| **Kinesis Firehose → Alloy** | 거의 실시간, Alloy의 `loki.source.awsfirehose` 활용 |
| **Subscription Filter → Lambda** | 가장 단순, 50~100줄 코드로 Loki push API 호출 |
| **S3 Export → Vector/Alloy** | 대량·저비용, 실시간성 낮음, backfill에 유리 |

**라벨 설계 필수**: `log_group`, `log_stream`, `aws_account_id`, `region`, `service`

---

## 6. Alloy vs Prometheus — 자주 하는 오해

**오해**: "Alloy가 메트릭도 수집하니까 Prometheus를 대체할 수 있지 않나?"

**사실**: Alloy는 **수집(agent) 계층**만 대체합니다.

Prometheus는 사실 두 역할을 한 몸에 갖고 있음:

| 역할 | Alloy가 대체? |
|------|--------------|
| ① Scraper (pull & forward) | ✅ 가능 |
| ② TSDB + PromQL 엔진 (저장/쿼리) | ❌ 불가능 |

Alloy는 저장소가 없어 반드시 **remote_write** 대상이 필요:

```
[수집] Alloy ──remote_write──▶ [저장] Prometheus / Mimir / VictoriaMetrics
```

- **Promtail + Prom scraper + OTel collector → Alloy 하나로 통합** ✔
- **Prometheus TSDB 자체를 버리고 싶다면 → Mimir / VictoriaMetrics / Thanos** ✔

한 줄 요약:
> **Alloy는 "수집 창구 통합"이고, Prometheus는 "저장소 + 쿼리 엔진".** 레이어가 다르기 때문에 Alloy가 Prometheus를 완전히 대체하지는 않습니다.

---

## 7. 확장 아키텍처 (AWS + Atlas 포함)

```
┌──────────────────────────── AWS ────────────────────────────┐
│  EC2 / Lambda / ECS / API Gateway                           │
│           │                                                 │
│           ▼                                                 │
│     CloudWatch Logs ──▶ Firehose/Lambda ──┐                 │
└───────────────────────────────────────────┼─────────────────┘
                                            │
                 MongoDB Atlas ──(Prom)─────┼──┐
                                            │  │
                                            ▼  ▼
┌──────────────────── 관측성 스택 ─────────────────────────────┐
│                                                              │
│   ┌──────────────────────────────────┐                       │
│   │           app (Node.js)          │                       │
│   │                                  │                       │
│   │  prom-client ──▶ /metrics ───────┼──┐                    │
│   │  winston     ──▶ stdout          │  │                    │
│   └──────────────────┬───────────────┘  │ HTTP pull          │
│                      │                  │                    │
│                      ▼                  │                    │
│            docker json-file             │                    │
│                      │                  │                    │
│                      ▼ tail             │                    │
│                 ┌──────────┐            │                    │
│                 │ Promtail │────┐       │                    │
│                 └──────────┘    │       │                    │
│                                 │       │ (+ Atlas Prom      │
│                  ┌──────────┐   │       │    endpoint        │
│                  │  Alloy   │───┤       │    scrape)         │
│                  │(CW / S3) │   │       │                    │
│                  └──────────┘   │ push  │                    │
│                                 ▼       ▼                    │
│                          ┌──────────┐  ┌────────────┐        │
│                          │   Loki   │  │ Prometheus │        │
│                          └─────┬────┘  └─────┬──────┘        │
│                                │             │               │
│                                └──────┬──────┘               │
│                                       ▼                      │
│                                    Grafana                   │
└──────────────────────────────────────────────────────────────┘
```

- **Promtail**: 로컬 컨테이너 로그 담당
- **Alloy**: 클라우드(CloudWatch, S3, Kafka 등) 로그/메트릭 담당
- 역할 분담이 실무 표준 구성

---

## 8. 실행 & 테스트 가이드

### 8-1. 사전 준비

- **Docker Desktop** 설치 & 실행 중
- 포트 `3000`, `3001`, `3100`, `9090` 이 비어 있어야 함
  ```bash
  lsof -i :3000 -i :3001 -i :3100 -i :9090
  ```

### 8-2. 스택 기동

```bash
# 프로젝트 루트에서
docker compose up -d

# 상태 확인 — 5개 서비스 모두 Up이어야 정상
docker compose ps
```

기대 출력 (예시):
```
NAME                   STATUS
observable-app-1         Up
observable-grafana-1     Up
observable-loki-1        Up
observable-prometheus-1  Up
observable-promtail-1    Up
```

로그를 따라가며 디버깅하려면:
```bash
docker compose logs -f promtail      # Promtail이 Loki로 push 하는지
docker compose logs -f prometheus    # 스크레이프 에러 여부
```

### 8-3. 엔드포인트 요약

| URL | 설명 | 로그인 |
|-----|------|--------|
| http://localhost:3000 | Node.js 앱 (Hello, Observable!) | — |
| http://localhost:3000/slow | 0.5~2.5초 지연 응답 | — |
| http://localhost:3000/error | 의도적 500 에러 | — |
| http://localhost:3000/metrics | prom-client 메트릭 (텍스트) | — |
| http://localhost:9090 | Prometheus 내장 UI | — |
| http://localhost:3001 | **Grafana (메인 UI)** | 익명 Admin 자동 로그인 |
| http://localhost:3100/ready | Loki 헬스체크 (UI 없음) | — |

### 8-4. 트래픽 생성 (테스트 데이터 만들기)

```bash
# 단건 테스트
curl localhost:3000/
curl localhost:3000/slow
curl localhost:3000/error

# 부하 생성 (의미 있는 그래프를 그리려면 추천)
for i in {1..50}; do curl -s localhost:3000/ > /dev/null; done
for i in {1..20}; do curl -s localhost:3000/slow > /dev/null; done
for i in {1..10}; do curl -s localhost:3000/error > /dev/null; done

# 지속 부하 (30초간 계속 요청)
while true; do
  curl -s localhost:3000/ > /dev/null
  curl -s localhost:3000/slow > /dev/null
  sleep 1
done
```

### 8-5. Prometheus UI에서 수집 상태 확인

http://localhost:9090 접속 후:

1. **Status → Targets** — `node-app (1/1 up)` 이어야 함
   - ❌ DOWN이면: app 컨테이너가 떠 있는지, `app:3000`이 네트워크에서 resolve 되는지 확인
2. **Graph 탭**에 쿼리 입력:
   ```promql
   up
   rate(http_requests_total[1m])
   http_request_duration_seconds_count
   ```

### 8-6. Grafana에서 메트릭 시각화 (Prometheus)

1. http://localhost:3001 → 좌측 **Explore**
2. 상단 데이터소스를 **Prometheus**로
3. 편집기 우측 **Code** 모드로 전환 후 입력:

| 목적 | PromQL |
|------|--------|
| 초당 요청 수 (route별) | `sum by (route) (rate(http_requests_total[1m]))` |
| 에러율 | `sum(rate(http_requests_total{status="500"}[1m])) / sum(rate(http_requests_total[1m]))` |
| 평균 지연시간 | `rate(http_request_duration_seconds_sum[1m]) / rate(http_request_duration_seconds_count[1m])` |
| **p95 지연시간 (권장)** | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))` |
| p50 / p95 / p99 | 위 쿼리에서 quantile 값만 `0.50` / `0.95` / `0.99` |

> 💡 패널 생성 시 **Standard options → Unit**을 `seconds (s)`로 맞추면 지연시간이 초 단위로 깔끔하게 보입니다.

### 8-7. Grafana에서 로그 조회 (Loki)

1. http://localhost:3001 → **Explore**
2. 데이터소스를 **Loki**로 전환
3. **Label browser** 클릭 → `service`, `container` 라벨이 보여야 정상

| 목적 | LogQL |
|------|-------|
| app 전체 로그 | `{service="app"}` |
| 에러만 | `{service="app"} |= "error"` |
| JSON 파싱 후 status 필터 | `{service="app"} | json | status = "500"` |
| slow 경로만 | `{service="app"} | json | path = "/slow"` |
| 초당 에러 로그 발생량 | `sum(rate({service="app"} |= "error" [1m]))` |

### 8-8. 메트릭 + 로그 동시 확인 (상관 분석)

Explore 화면 우측 상단 **Split** 버튼 → 왼쪽에 Prometheus p95, 오른쪽에 Loki `{service="app"}`를 띄우면 **같은 시간축**으로 "지연시간이 튄 순간의 로그"를 바로 확인할 수 있습니다.

### 8-9. 대시보드 만들기 (선택)

1. 좌측 **Dashboards → New → New dashboard**
2. **Add visualization** → Prometheus 선택
3. 추천 3패널 구성:
   - **Request rate**: `sum by (route) (rate(http_requests_total[1m]))` — Time series
   - **p50/p95/p99 latency**: 위 histogram_quantile 3개 — Time series, Unit: seconds
   - **Latency heatmap**: `sum by (le) (rate(http_request_duration_seconds_bucket[1m]))` — **Heatmap**
4. 우측 상단 💾 저장

### 8-10. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-----------|
| Grafana 데이터소스에 Loki/Prometheus 없음 | `docker compose restart grafana` (프로비저닝 재로드) |
| Loki에 `No data` | Promtail 로그 확인: `docker compose logs promtail` — `docker.sock` 권한 문제가 흔함 |
| Prometheus Targets가 DOWN | app 컨테이너 헬스체크: `docker compose logs app` / 포트 충돌 여부 |
| 메트릭 쿼리가 `No data` | Histogram은 **`_bucket` / `_sum` / `_count`** 중 하나를 써야 함 (`http_request_duration_seconds`만으론 안 뜸) |
| `service` 라벨이 안 잡힘 | [docker-compose.yml](docker-compose.yml)의 `labels: com.docker.compose.service=app` 누락 확인 |
| 시간 범위 밖이라 비어 보임 | Grafana 우측 상단 **Last 5 minutes** 정도로 좁혀보기 |

### 8-11. 정리 / 초기화

```bash
# 중지 (데이터 유지)
docker compose stop

# 완전 삭제 (컨테이너 + 네트워크)
docker compose down

# 볼륨까지 포함 완전 초기화
docker compose down -v
```

---

## 9. 빠른 검증 체크리스트

기동 직후 이 순서대로 확인하면 전체 파이프라인이 정상인지 판별됩니다:

- [ ] `docker compose ps` → 5개 서비스 모두 Up
- [ ] http://localhost:3000 → `{"message":"Hello, Observable!"}`
- [ ] http://localhost:3000/metrics → `http_requests_total{...} N` 같은 텍스트
- [ ] http://localhost:9090/targets → `node-app (1/1 up)`
- [ ] Grafana Explore → Prometheus → `up` 쿼리에서 `1` 반환
- [ ] `curl localhost:3000/error` 실행 후
- [ ] Grafana Explore → Loki → `{service="app"} |= "error"` 에서 로그 확인

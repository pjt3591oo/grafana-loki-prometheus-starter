# Observable — 관측성 3기둥 실습 스택

Node.js 애플리케이션을 대상으로 **메트릭 · 로그 · 트레이스** 3요소를 모두 수집하고 Grafana에서 통합 시각화하는 Docker Compose 기반 학습 프로젝트.

- **메트릭**: Prometheus
- **로그**: Loki (수집기: Promtail)
- **트레이스**: Tempo (수집기: OpenTelemetry Collector)
- **시각화**: Grafana

---

## 1. 전체 구조

```
┌──────────────────────── Docker Compose Network ──────────────────────────┐
│                                                                          │
│  ┌─────────────────────────────────────┐                                 │
│  │         app  (Node.js)  :3000       │                                 │
│  │                                     │                                 │
│  │  prom-client ──▶ /metrics (HTTP) ───┼──┐ (1) pull (15s)               │
│  │  winston     ──▶ stdout         ────┼──┼──┐                           │
│  │  OTel SDK    ──▶ OTLP HTTP      ────┼──┼──┼──┐                        │
│  └─────────────────────────────────────┘  │  │  │                        │
│                                           │  │  │                        │
│    /var/lib/docker/containers/...◀────────┼──┘  │                        │
│           <id>-json.log                   │     │                        │
│                  │ tail                   │     │                        │
│                  ▼                        │     │                        │
│           ┌────────────┐                  │     │                        │
│           │  Promtail  │                  │     │                        │
│           └──────┬─────┘                  │     │                        │
│                  │ (2) push               │     │                        │
│                  │                        │     ▼                        │
│                  │                        │  ┌──────────────────────┐    │
│                  │                        │  │   OTel Collector     │    │
│                  │                        │  │   :4318 (OTLP HTTP)  │    │
│                  │                        │  │                      │    │
│                  │                        │  │  receivers           │    │
│                  │                        │  │   → processors       │    │
│                  │                        │  │     (memory_limiter, │    │
│                  │                        │  │      attributes,     │    │
│                  │                        │  │      batch)          │    │
│                  │                        │  │   → exporters        │    │
│                  │                        │  └──────────┬───────────┘    │
│                  │                        │             │                │
│                  ▼                        ▼             ▼ OTLP gRPC      │
│           ┌──────────┐           ┌────────────┐  ┌──────────┐            │
│           │   Loki   │           │ Prometheus │  │  Tempo   │            │
│           │  :3100   │           │   :9090    │  │  :3200   │            │
│           └─────┬────┘           └─────┬──────┘  └────┬─────┘            │
│                 │ LogQL               │ PromQL       │ TraceQL           │
│                 └──────────┬──────────┴──────────────┘                   │
│                            ▼                                             │
│                   ┌────────────────┐                                     │
│                   │    Grafana     │                                     │
│                   │     :3001      │                                     │
│                   └────────────────┘                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

**핵심 원칙**
- **메트릭 = Pull**: Prometheus가 app의 `/metrics` HTTP 엔드포인트를 주기적으로 긁어감
- **로그 = Push**: winston stdout → Docker json-file → Promtail tail → Loki push
- **트레이스(Collector없이 tempo로 직접 push 가능) = Push**: OTel SDK → Collector(버퍼/처리) → Tempo push 
- app 내부에서 **메트릭 · 로그 · 트레이스는 서로 독립된 세 출구**를 가지며 각자의 파이프라인을 따름

---

## 2. 서비스별 역할

| 서비스 | 포트 | 역할 |
|--------|------|------|
| **app** | 3000 | Express 서버. `/`, `/slow`, `/error`, `/metrics` 엔드포인트 |
| **prometheus** | 9090 | 15초마다 `app:3000/metrics` 스크레이프. 내장 UI 제공 |
| **loki** | 3100 | 로그 저장소. API-only (UI 없음) |
| **promtail** | — | `docker.sock`으로 컨테이너 로그 tail → Loki push |
| **tempo** | 3200 | 트레이스 저장소. Grafana에서 TraceQL로 조회 |
| **otel-collector** | 4318/4317 | 앱 SDK와 Tempo 사이의 수집·처리 허브 |
| **grafana** | 3001 | 시각화 UI (익명 Admin) |

---

## 3. 각 데이터 파이프라인 상세

### 3-1. 메트릭 (Prometheus)

`prom-client`가 app 프로세스 메모리에 Counter/Histogram을 누적 → Prometheus가 15초마다 HTTP GET `/metrics` 로 긁어감. **파일 I/O 없음**, 완전 메모리 기반.

### 3-2. 로그 (Loki)

winston은 stdout으로만 출력 → Docker의 json-file 드라이버가 `/var/lib/docker/containers/<id>/<id>-json.log`에 저장 → Promtail이 `docker.sock`으로 컨테이너를 발견하고 해당 파일을 tail → Loki로 push.

**Promtail 라벨 매핑**:
- `__meta_docker_container_name` → `container`
- `__meta_docker_container_label_com_docker_compose_service` → `service`
- `__meta_docker_container_log_stream` → `logstream`

### 3-3. 트레이스 (Tempo + OTel + Collector)

OTel SDK가 app의 HTTP/Express/DB 호출을 **자동 계측**하여 span을 생성 → OTLP HTTP로 Collector에 전송 → Collector가 처리(배치, 속성 보강) 후 Tempo에 gRPC로 전달.

#### 계측 방식 두 가지

**① 자동 계측** — `require('./tracing')` 한 줄로 시작
- HTTP/Express/DB 드라이버 같은 **프레임워크 경계**가 자동으로 span이 됨
- 비밀: `require-in-the-middle` 훅 + monkey patching — 모듈이 로드될 때 원본을 "span으로 감싼 버전"으로 바꿔치기

**② 수동 계측** — Controller/Service/Repository 계층
- 사용자 코드는 자동으로 잡히지 않음 → `tracer.startActiveSpan(...)`으로 직접 감쌈
- [app/index.js](app/index.js)의 `/error` 핸들러가 3계층 수동 계측 예시 포함
  - `ErrorController.handle` (root)
  - `ErrorService.validateRequest`
  - `ErrorRepository.fetchFromDatabase` (의도적 에러)

#### Context 전파 (AsyncLocalStorage)

서비스/리포지토리 메서드가 "자기가 어느 요청에 속하는지" 알 수 있는 이유:
- Node.js의 **AsyncLocalStorage**를 이용해 HTTP 요청 진입 시점에 trace context를 store에 심음
- 이후 async/await 경계를 넘어도 **인과 사슬을 따라 같은 store가 유지**됨
- 사용자 코드는 `trace.getSpan(context.active())`로 꺼내 쓸 수 있음 (또는 그냥 `startActiveSpan`으로 자연스럽게 상속)

---

## 4. OTel Collector의 역할

### 구조 (3계층 파이프라인)

```
[Receivers] → [Processors] → [Exporters]
   OTLP        memory_limiter   otlp/tempo
               attributes       debug
               batch
```

### 왜 직접 Tempo가 아닌 Collector로?

| 이점 | 설명 |
|------|------|
| **Decoupling** | 앱은 Collector 한 곳만 알면 됨. 백엔드 교체/추가 자유 |
| **버퍼링/재시도** | Tempo 장애 시 Collector의 `sending_queue`가 흡수 |
| **샘플링** | tail sampling (완결된 trace 중 에러/느린 것만 보존) — 앱 단독 불가 |
| **보강/마스킹** | 환경 속성 주입, PII 제거 등 정책을 한곳에 |
| **Fan-out** | Tempo + S3 + 분석 DW 등 여러 백엔드 동시 전송 |

### 주의 — 규모에 따라 과할 수 있음

- 단일 서비스, 낮은 트래픽, 단일 백엔드면 **앱 → Tempo 직접**도 충분
- Collector의 이익은 **"미래의 운영 유연성"**이지 즉각적 동작 이익이 아님
- 이 프로젝트에서는 학습 목적으로 도입

---

## 5. 주요 개념 정리

### 5-1. Winston 로그의 실제 저장 경로

현재 winston은 `Console` 트랜스포트만 사용 → 파일이 아닌 **stdout**으로만 출력. Docker의 json-file 드라이버가 stdout을 가로채 다음 경로에 저장:

```
/var/lib/docker/containers/<container-id>/<container-id>-json.log
```

- 한 줄당 JSON: `{"log":"...","stream":"stdout","time":"..."}`
- `max-size: 10m`, `max-file: 3` → 총 30MB 롤링
- Promtail이 이 파일을 tail
- macOS(Docker Desktop)에서는 LinuxVM 내부라 직접 접근 불가 → `docker logs <container>`로 확인

### 5-2. 외부 시스템 연동 패턴

#### MongoDB Atlas (managed DB)
- **메트릭**: Atlas 공식 Prometheus Integration → Prometheus가 직접 scrape
- **로그**: S3 export → Alloy/Vector → Loki

#### AWS CloudWatch 통합 수집
Lambda/ECS/API Gateway는 에이전트 설치 불가 → CloudWatch가 단일 집결지:

```
AWS 리소스 ──▶ CloudWatch Logs ──▶ [수집기] ──▶ Loki
```

수집기 선택지:
- **Kinesis Firehose → Alloy** (거의 실시간)
- **Subscription Filter → Lambda** (간단)
- **S3 Export → Vector/Alloy** (저비용, backfill용)

#### S3 vs CloudWatch 관계
- 기본적으로 **별개 저장소**. 자동 동기화 없음
- CloudWatch = 실시간 운영/디버깅 (비쌈, 검색 가능)
- S3 = 대량 장기 보관 (저렴, 직접 쿼리 불가)
- 필요 시 명시적 연결 (Export Task, Subscription → Firehose)

#### LocalStack / MinIO
- **LocalStack**: CloudWatch/S3 API 에뮬레이션, SDK 테스트 용도
- **MinIO**: S3 API 완벽 호환, 객체 저장소로서는 우수하지만 **AWS 생태계(Lambda/CloudWatch) 연동은 없음**
- 실무 조합: LocalStack + MinIO 병행 (S3는 MinIO가 안정적)

### 5-3. Alloy vs Prometheus 오해

**Alloy**는 수집(agent) 계층이고 **Prometheus**는 저장+쿼리 엔진:

| 역할 | Alloy가 대체? |
|------|-------------|
| Scraper (pull & forward) | ✅ |
| TSDB + PromQL 엔진 | ❌ |

Alloy는 저장소가 없어 `remote_write`로 Prometheus/Mimir/VictoriaMetrics에 보내야 함.

### 5-4. Alloy가 통합하는 도구들

```
Promtail + Prometheus agent + OTel Collector + Grafana Agent = Grafana Alloy
```

- Promtail은 2026년 2월 EOL → Alloy가 후속
- River 설정 언어로 파이프라인을 코드처럼 표현
- 이 프로젝트에선 "학습 단순화"를 위해 Alloy 대신 각 수집기를 분리 운영 중

### 5-5. Trace 파이프라인의 부하 특성

- trace는 요청당 **수십~수백 span** → 로그보다 10~50배 데이터량
- Push 모델이라 자연스러운 백프레셔 없음
- 운영상 대응:
  - **샘플링** (head/tail)
  - **Collector 개입** (버퍼링)
  - **Kafka/Kinesis 중간 큐** (대규모)
  - **BatchSpanProcessor 튜닝** (앱 보호)

### 5-6. Queue-backed Trace Pipeline

"Tempo EC2 부담을 줄이려 AWS 관리형 큐에 버퍼링" 아이디어:
- 방향성은 옳지만 **SQS는 부적합** (256KB 제한, 비용, 폴링 지연)
- 적합한 대안: **Kinesis Data Streams / MSK / Firehose**
- 소규모에선 **Collector 영속 큐**로 동일 효과를 훨씬 저렴하게 얻음

---

## 6. 실행 & 테스트 가이드

### 6-1. 사전 준비
- **Docker Desktop** 설치 & 실행 중
- 포트 `3000`, `3001`, `3100`, `3200`, `4317`, `4318`, `9090` 비어있음 확인

```bash
lsof -i :3000 -i :3001 -i :3100 -i :3200 -i :4317 -i :4318 -i :9090
```

### 6-2. 스택 기동

```bash
docker compose up -d
docker compose ps        # 7개 서비스 Up 확인
```

로그 확인:
```bash
docker compose logs -f otel-collector   # trace 파이프라인 동작 확인
docker compose logs -f promtail         # 로그 수집 동작 확인
```

### 6-3. 엔드포인트

| URL | 설명 |
|-----|------|
| http://localhost:3000 | Node.js 앱 (Hello, Observable!) |
| http://localhost:3000/slow | 0.5~2.5초 지연 응답 |
| http://localhost:3000/error | 의도적 500 에러 (수동 계측 예시) |
| http://localhost:3000/metrics | prom-client 메트릭 텍스트 |
| http://localhost:9090 | Prometheus 내장 UI |
| http://localhost:3001 | **Grafana 메인 UI** |
| http://localhost:3200/ready | Tempo 헬스체크 |

### 6-4. 트래픽 생성

```bash
curl localhost:3000/
curl localhost:3000/slow
curl localhost:3000/error

# 부하 생성
for i in {1..50}; do curl -s localhost:3000/ > /dev/null; done
for i in {1..20}; do curl -s localhost:3000/slow > /dev/null; done
for i in {1..10}; do curl -s localhost:3000/error > /dev/null; done
```

### 6-5. Grafana 사용법

#### 메트릭 (Prometheus)
Explore → Prometheus → Code 모드:

| 목적 | PromQL |
|------|--------|
| 요청률 | `sum by (route) (rate(http_requests_total[1m]))` |
| p95 지연 | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))` |
| 에러율 | `sum(rate(http_requests_total{status="500"}[1m])) / sum(rate(http_requests_total[1m]))` |

**중요**: Histogram은 `_bucket` / `_sum` / `_count` 중 하나를 써야 함.

#### 로그 (Loki)
Explore → Loki → Label browser 활용:

| 목적 | LogQL |
|------|-------|
| 전체 app 로그 | `{service="app"}` |
| 에러만 | `{service="app"} \|= "error"` |
| JSON 파싱 | `{service="app"} \| json \| status = "500"` |

#### 트레이스 (Tempo)
Explore → Tempo → Search 탭 → Service Name: `observable-app` 선택

`/error` trace를 열면 Waterfall 뷰에 다음 계층이 표시됨:
```
GET /error                              ← 자동 (http)
 └─ middleware - ... (여러 개)           ← 자동 (express)
     └─ request handler - /error        ← 자동 (express)
         └─ ErrorController.handle      ← 수동
             ├─ ErrorService.validateRequest
             └─ ErrorRepository.fetchFromDatabase 🔴 (에러)
```

### 6-6. 메트릭 + 로그 + 트레이스 상관 분석

Explore 우측 **Split** 버튼으로 여러 패널을 같은 시간축에 띄우면 "지연 스파이크 순간의 로그·트레이스" 동시 확인 가능.

### 6-7. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-----------|
| Grafana에 데이터소스 없음 | `docker compose restart grafana` |
| Loki `No data` | `docker compose logs promtail` 확인 (docker.sock 권한) |
| Prometheus Target DOWN | `docker compose logs app` / 포트 충돌 |
| 메트릭 쿼리 `No data` | `_bucket` / `_sum` / `_count` 붙였는지 확인 |
| Tempo에 trace 없음 | `docker compose logs otel-collector`에서 span 수신 로그 확인 |
| OTLP 전송 실패 | app의 `OTEL_EXPORTER_OTLP_ENDPOINT` 환경변수 확인 |

### 6-8. 정리

```bash
docker compose stop       # 중지 (데이터 유지)
docker compose down       # 삭제 (볼륨 유지)
docker compose down -v    # 완전 초기화
```

---

## 7. 빠른 검증 체크리스트

- [ ] `docker compose ps` → 7개 서비스 Up
- [ ] http://localhost:3000 → `{"message":"Hello, Observable!"}`
- [ ] http://localhost:9090/targets → `node-app (1/1 up)`
- [ ] Grafana Explore → Prometheus → `up` 쿼리 = 1
- [ ] `curl localhost:3000/error` 후
  - Loki → `{service="app"} \|= "error"` 에서 로그 확인
  - Tempo → Search → `observable-app` trace 확인 (수동 계층 span 포함)
- [ ] Collector 로그: `docker compose logs otel-collector | grep Traces`

---

## 8. 확장 아키텍처 (AWS + Atlas 포함)

실무 확장 시 예상되는 구조 — 이 프로젝트 맥락의 사고 실험:

```
┌──────────────────── AWS ────────────────────┐
│  EC2 / Lambda / ECS / API Gateway           │
│           │                                 │
│           ▼                                 │
│     CloudWatch Logs ──▶ Firehose/Lambda ──┐ │
└───────────────────────────────────────────┼─┘
                                            │
                 MongoDB Atlas ──(Prom)─────┼──┐
                                            │  │
                                            ▼  ▼
┌──────────────────── 관측성 스택 ─────────────────────┐
│                                                     │
│   app ──▶ OTel Collector (또는 Alloy) ──┬──▶ Tempo  │
│   Promtail ──────────────────────────── ┼──▶ Loki   │
│   Prometheus scrape ──────────────────── └──▶ Prom  │
│                            │                        │
│                            ▼                        │
│                        Grafana                      │
└─────────────────────────────────────────────────────┘
```

- **Promtail**: 로컬 컨테이너 로그 담당
- **Alloy / Collector**: 클라우드 소스 + trace 버퍼링 허브
- 대규모에선 Kafka/Kinesis를 중간에 두고 Collector agent-gateway 2단 구성
- Tempo/Prometheus 저장소는 S3 기반 Mimir/VictoriaMetrics로 수평 확장

---

## 9. 디렉토리 구조

```
observable/
├── app/                          # Node.js 앱 (Express + OTel + prom-client)
│   ├── index.js                  # 라우트, 메트릭, /error 수동 계측
│   ├── tracing.js                # OTel SDK 초기화
│   ├── Dockerfile
│   └── package.json
├── prometheus/
│   └── prometheus.yml            # scrape_configs
├── promtail/
│   └── config.yml                # Docker SD + relabel
├── loki/                         # (기본 내장 설정 사용)
├── tempo/
│   └── tempo.yaml                # OTLP receiver, 로컬 저장
├── otel-collector/
│   └── config.yaml               # receivers/processors/exporters
├── grafana/
│   └── provisioning/
│       └── datasources/
│           └── datasources.yml   # Prom/Loki/Tempo 자동 등록
└── docker-compose.yml
```

---

## 10. 다음 단계 학습 주제

- **로그에 trace_id 자동 삽입** → Loki ↔ Tempo jump 연결
- **Prometheus Exemplar** → 히스토그램 점 → trace로 점프
- **Alerting & SLO** — Grafana Alerting / Prometheus Alertmanager
- **Sampling** — head/tail sampling을 Collector에서 구현
- **Alloy 도입** — Promtail + Collector + Prom agent를 Alloy 하나로 통합
- **장기 저장소** — Mimir / VictoriaMetrics / S3 backend
- **Kubernetes 이식** — kube-prometheus-stack, loki-stack Helm

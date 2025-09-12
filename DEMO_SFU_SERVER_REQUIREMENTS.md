# 데모 SFU 서버 요구사항 정의서 (Draft v0.1)

> 본 문서는 강사 클라이언트(React) 개발을 위해 **로컬에서 실행 가능한 데모 SFU 서버**의 요구사항을 정의합니다. 서버는 프로젝트 내에 준비된 4개의 MP4 파일을 **실시간처럼** 스트리밍하여, 실제 카메라 연결 없이도 강사 클라이언트의 스트리밍·화면 전환·화질 검증을 가능하게 합니다. (참고 아키텍처 및 품질 정책: Weldbeing T – MVP 시스템 아키텍처 Draft v0.3.2.)​

---

## 1. 목적(Goal)

* 강사 클라이언트 개발·테스트 시 **안드로이드 태블릿 앱/실장비/실서버 없이**도 실시간 스트리밍 UX를 검증.
* **여러 스트림의 화질/프레임 정책**을 모사하여 실제 운영 환경과의 **품질 갭 최소화**.
* **streamKey** 기반으로 **여러 스트림을 동시에 구분**하고, **연결/해제/전환** 시의 상태·지연·버퍼링 동작을 재현.

---

## 2. 범위(Scope)

* **포함**

  * 로컬 데모 SFU 서버(단일 프로세스, Docker 가능).
  * **MP4(H.264) 4개**를 **실시간 유사(fmp4 또는 WebRTC RTP 타이밍 기반)**로 다중 스트림 제공.
  * **WebSocket**(필수) + (옵션) **mediasoup**을 활용한 WebRTC 경로.
  * **streamKey**로 스트림 식별·구독·해제 지원.
  * **메타데이터 및 이벤트(마킹 연동 가능성) 인터페이스** 초안.

* **제외**

  * 실제 학생 태블릿 앱, 실제 카메라 RTSP 인입.
  * AI 분석, 사용자 인증/권한, 영구 저장(레코딩) 기능의 본격 구현.
  * TURN/STUN 외부 네트워크 홀펀칭(로컬 개발 환경 기준).

---

## 3. 용어 정의

* **streamKey**: 각 MP4 파일/스트림을 고유 식별하는 문자열(예: "WELD-A1", "WELD-A2" …). WebSocket 및 (옵션) WebRTC 시그널링에 사용.
* **실시간 유사(Realtime-like)**: 정해진 프레임 타임라인에 맞춰 연속 세그먼트/패킷 송출, 지연/버퍼 제어 포함.
* **데모 SFU**: 단일 서버 프로세스에서 다중 반출을 중계하는 구성. (실서비스 단계의 실제 SFU와 **동작·인터페이스 호환성**을 우선 고려)

---

## 4. 참조 아키텍처 준수 항목

* **원본 H.264/MP4 기반** 전송(가능하면 재인코딩 없이 **transmux** 중심), **마킹 이벤트와 동기화 가능한 타임스탬프** 유지(향후 연동).
* **강사 UI** 기본 4분할 뷰 가정(썸네일+주 화면), **더블클릭 시 마킹**과 같은 상호작용 이벤트를 서버에 전달 가능한 메타 채널 제공(초안).

---

## 5. 시스템 개요

### 5.1 구성도(개략)

```
[React Instructor Client]
        │   WebSocket (Signaling/Control + fMP4 data channel in Demo Mode)
        │   (Option) WebRTC via mediasoup (RTP/DTLS/SCTP)
[Demo SFU Server]
        ├── Stream Router (streamKey별 팬아웃)
        ├── Transmuxer (MP4 → fMP4 segments) / (Option) Encoder/Scaler
        ├── QoS/Clock (실시간 타이밍)
        └── Local Media Store (./media/*.mp4 4개)
```

### 5.2 실행 모드

* **Mode A (기본)**: **WebSocket + MSE**

  * 서버: MP4 → **fMP4**(ISO-BMFF) **init segment + media segments** 생성 후 WebSocket으로 푸시.
  * 클라이언트: MediaSource Extensions(MSE)로 fMP4 append → `<video>` 재생.
* **Mode B (옵션)**: **mediasoup(WebRTC)**

  * 서버: mediasoup Router/Transport/Producer/Consumer 구성, (필요 시) SW 인코딩/스케일링.
  * 클라이언트: WebRTC PeerConnection + 시그널링(WebSocket).

---

## 6. 기능 요구사항(Functional Requirements)

### FR-1. 미디어 소스

* **FR-1.1** 서버는 **프로젝트 로컬 디렉토리 `./media`**에 위치한 **4개의 MP4(H.264) 파일**을 사용한다.
* **FR-1.2** 각 파일은 **고정 streamKey**로 매핑된다. 예:

  * `WELD-A1 → a1.mp4`, `WELD-A2 → a2.mp4`, `WELD-A3 → a3.mp4`, `WELD-A4 → a4.mp4`.
* **FR-1.3** 서버 시작 시 **메타 스캔**(코덱/해상도/프레임레이트/길이)을 수행하고 catalog를 빌드한다.
* **FR-1.4** `/catalog?count=n` 요청 시 기존 파일을 반복 사용하여 **n개의 논리 스트림**을 제공한다.

### FR-2. WebSocket 제어/데이터 채널

* **FR-2.1** 엔드포인트: `ws://localhost:<PORT>/ws`.
* **FR-2.2** 메시지 포맷(JSON):

  * **구독**:

    ```json
    { "type": "subscribe", "streamKey": "WELD-A1" }
    ```
  * **해제**:

    ```json
    { "type": "unsubscribe", "streamKey": "WELD-A1" }
    ```
  * **상태 조회**:

    ```json
    { "type": "status" }
    ```
  * **마킹 이벤트(옵션, 초안)**:

    ```json
    { "type": "mark", "streamKey": "WELD-A1", "timestamp": 125.4, "markType": "correction", "instructorId": "t01" }
    ```
* **FR-2.3** 서버 → 클라이언트 알림(JSON):

  * **구독 승인**: `{"type":"subscribed","streamKey":"WELD-A1"}`
  * **세그먼트 전송**(Mode A): 바이너리 프레임(헤더 + fMP4 payload). 헤더 예:

    ```json
    { "type": "segment", "streamKey": "WELD-A1", "seq": 123, "isInit": false, "pts": 123456.78 }
    ```
  * **오류/종료**: `{"type":"error","code":"E_STREAM_NOT_FOUND"}`, `{"type":"eos","streamKey":"WELD-A1"}`

### FR-3. 실시간 유사 송출

* **FR-3.1** 서버는 **원본 FPS**를 기준으로 **타이밍 큐**를 설정하여 순서대로 세그먼트/샘플을 전송한다.
* **FR-3.2** **초기 버퍼목표(예: 500~1500ms)**를 유지하도록 전송 속도를 제어한다.
* **FR-3.3** **일시정지/재시작/루프** 옵션(개발 편의)을 지원한다:

  ```json
  { "type":"control", "streamKey":"WELD-A1", "action":"pause|resume|seek|loopOn|loopOff" }
  ```

### FR-4. 품질 프로파일

* **FR-4.1** 데모 서버는 모든 스트림을 **1080p, 30fps** 목표로 전송한다. (원본이 낮으면 원본 유지)
* **FR-4.2** 향후 비선택 스트림 다운스케일 시뮬레이션은 별도 과제로 남긴다.

### FR-5. 세션/마킹(초안 연동)

* **FR-5.1** 마킹 이벤트(JSON)는 타임스탬프 기반이며 서버가 **메타 채널로 수집/로깅**한다. (로컬 파일 저장 옵션)
* **FR-5.2** 마킹 스키마는 다음 예시와 **호환 가능**해야 한다.
  `{sessionId, studentId, timestamp, markType, instructorId}`​

### FR-6. 상태/헬스체크

* **FR-6.1** `GET /healthz` → `200 OK { "status":"ok", "uptime":123.45 }`
* **FR-6.2** `GET /catalog` → 등록된 streamKey 및 미디어 메타 반환.

---

## 7. 비기능 요구사항(Non-Functional Requirements)

* **NFR-1 성능/지연**: 각 스트림 **Glass-to-Glass 유사 지연 300~800ms**(로컬 기준) 목표.
* **NFR-2 동시성**: 단일 서버 프로세스에서 **동시 시청자(탭) 4~8개** 안정 유지.
* **NFR-3 안정성**: 네트워크 순간 지연/패킷 드롭 시 **재전송/리커버리** 제공(Mode A: 세그먼트 재발행, Mode B: NACK/RTX).
* **NFR-4 확장성**: 추후 실제 Ingest/SFU로 **구성 교체** 시 클라이언트 코드 변경 최소화(메시지·시그널링 인터페이스 유지).
* **NFR-5 보안(개발용)**: 로컬 전용. 외부 노출 금지. 필요 시 **localhost 인증 토큰** 간이 적용.
* **NFR-6 로그**: 연결/구독/전환/오류/지연지표를 **구조화 로그(JSON)**로 남김.

---

## 8. 인터페이스 명세

### 8.1 HTTP

* `GET /healthz`
* `GET /catalog` (옵션 `?count=n`) →

  ```json
  {
    "streams": [
      { "streamKey":"WELD-A1","path":"./media/a1.mp4","codec":"h264","width":1920,"height":1080,"fps":30 },
      ...
    ]
  }
  ```

  예: `/catalog?count=50` 요청 시 50개의 streamKey 목록을 반환한다.

### 8.2 WebSocket (시그널링/데이터)

* **URL**: `ws://localhost:<PORT>/ws`
* **프로토콜**:

  * 텍스트 프레임: 제어 메시지(JSON)
  * 바이너리 프레임: fMP4 세그먼트(Mode A)
* **에러 코드 표(예시)**

  * `E_STREAM_NOT_FOUND` (404) – 알 수 없는 streamKey
  * `E_ALREADY_SUBSCRIBED` (409) – 중복 구독
  * `E_INTERNAL` (500) – 내부 처리 오류

### 8.3 WebRTC (옵션)

* **시그널링**: WebSocket 텍스트(JSON)

  * 예: `offer`, `answer`, `ice`, `ready`, `produce`, `consume`
* **코덱**: H.264 우선(클라이언트 호환성), 필요 시 VP8/Opus 추가.
* **네트워크**: 로컬 개발 기준 STUN 없이 진행(필요 시 `stun:stun.l.google.com:19302`).

---

## 9. 데이터 모델

### 9.1 카탈로그

```json
type Catalog = {
  streams: Array<{
    streamKey: string;
    path: string;
    codec: "h264";
    width: number;
    height: number;
    fps: number;
    durationSec: number;
  }>
}
```

### 9.2 세그먼트 헤더(Mode A)

```json
type SegmentHeader = {
  type: "init" | "segment";
  streamKey: string;
  seq: number;
  isInit: boolean;
  pts: number;        // ms 또는 s (명시)
  dts?: number;
  duration?: number;  // segment duration
}
```

### 9.3 마킹 이벤트(초안)

```json
type MarkEvent = {
  sessionId: string;
  studentId: string;
  streamKey: string;
  timestamp: number;   // seconds
  markType: "correction" | "note" | "highlight";
  instructorId: string;
}
```

---

## 10. 상태 머신 & 시나리오

1. **클라이언트 초기화** → `GET /catalog` 또는 `GET /catalog?count=n` → streamKey 목록 표시
2. **구독 요청**(`subscribe`) → 서버 `subscribed` 응답 → **init segment** 수신 → **media segment** 주기 수신
3. **다중 구독**(기본 4개, 확장 가능) → 여러 `<video>`에서 동시 재생
4. **해제**(`unsubscribe`) → 송출 중지
5. **연결 종료** → 서버 리소스 해제

---

## 11. 운영/배포(개발용)

* **구성**: Node.js + TypeScript 권장. ffmpeg/MP4Box 이용 가능. (옵션) mediasoup.
* **환경변수**:

  * `PORT=8080`
  * `MEDIA_DIR=./media`
  * `MODE=ws|webrtc|hybrid`
  * `STREAM_COUNT=50` (옵션, 초기 스트림 수 확장)
* **실행**:

  * 로컬: `pnpm dev` / Docker: `docker compose up -d`
* **모니터링**: `/healthz` + 구조화 로그.

---

## 12. 테스트(수용·검증 기준)

* **TC-1 카탈로그 로드**: 4개의 streamKey와 메타정보를 정상 획득.
* **TC-2 구독/해제**: 각 streamKey 구독 시 **1초 내 init** + **3초 내 첫 media** 수신.
* **TC-3 동시 4스트림**: 4개 스트림 동시 재생 시 **합산 CPU <70%**, 드랍률 <1%.
* **TC-4 스트림 확장**: `/catalog?count=50` 요청 시 50개의 streamKey 반환 및 구독 가능.
* **TC-5 지연 목표**: 각 스트림 End-to-End **<800ms**(로컬).
* **TC-6 오류 처리**: 알 수 없는 streamKey → `E_STREAM_NOT_FOUND` 반환.
* **TC-7 루프 재생**: 파일 종료 후 루프 모드에서 연속 재생 확인.
* **TC-8 마킹(옵션)**: `mark` 메시지 수신 및 로그 기록.

---

## 13. 보안·프라이버시(개발용)

* 로컬 개발 한정. 외부로 포트 오픈 금지.
* 임시 토큰 헤더/WS 쿼리(`?token=local-dev`) 지원 가능.
* 로그에 **개인식별정보 미기록** 원칙.

---

## 14. 제약 및 가정

* H.264 + MP4 파일 가정(HEVC/AV1 비포함).
* MSE 지원 브라우저(Chromium 계열) 우선.
* 실시간성은 로컬 환경 기준 수치(네트워크/CPU 스펙 따라 변동).

---

## 15. 향후 과제(Next)

* 실제 **RTSP/SRT Ingest** → 실 SFU 연동으로 전환.
* **마킹 이벤트**와 재생기의 **정밀 동기화**(세그먼트 타임스탬프 기준).
* **원본 저장/리플레이 파이프라인** 및 **AI 분석 트리거** 연계.​

---

## 16. 부록 A — 메시지 예시

**구독 → 세그먼트 수신**

```json
// C → S
{ "type":"subscribe","streamKey":"WELD-A1" }

// S → C
{ "type":"subscribed","streamKey":"WELD-A1" }
// 이후: 바이너리 프레임( init → segment* )
```

**상태 조회**

```json
{ "type":"status" }
```

**오류 응답**

```json
{ "type":"error","code":"E_STREAM_NOT_FOUND","message":"Unknown streamKey: WELD-AX" }
```

---

## 17. 부록 B — 클라이언트(React) 참고 구현 포인트

* **Mode A(MSE)**: WebSocket 바이너리 수신 → init/segment 식별 → `MediaSource`/`SourceBuffer`에 순차 append → **back-pressure** 및 **timestampOffset** 관리.
* **동시 스트림**: 썸네일/주 화면 등 여러 `<video>` 요소에서 streamKey별 재생을 관리한다.
* **에러 복구**: append 오류 시 **buffer clear & resync** 루틴 제공.
* **마킹 이벤트**: 더블클릭 시 `mark` 메시지 송신(향후 실서버와 호환).

---

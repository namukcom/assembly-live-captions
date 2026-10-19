# 국회 생중계 자막

국회 위원회 생중계의 자막을 수집하고, PC·모바일 브라우저에서 채널별 실시간 자막과 날짜별 기록을 확인하는 웹 서비스입니다. 오디오와 영상 재생, 자막 검색과 TXT 다운로드를 지원합니다.

서비스 주소는 [soju.day](https://soju.day), 저장소는 [assembly-live-captions](https://github.com/namukcom/assembly-live-captions)입니다. 이 문서는 **현재 저장소 소스**를 기준으로 합니다. 기능 브랜치에 있는 변경은 운영 배포가 끝나기 전까지 서비스에 표시되지 않을 수 있습니다.

## 문서 안내

| 문서 | 내용 |
| --- | --- |
| [사용자 안내](SITE_INTRO.md) | 채널·날짜 선택, 자막·오디오·영상, 검색·다운로드, 전체화면 |
| [설치와 운영](DEPLOY.md) | 실행 설정, 네트워크·HTTPS, 수집 상태 확인, 업데이트·데이터 보존 |
| [GitHub 작업과 자동 배포](GITHUB_DEPLOY.md) | 기능 브랜치, PR 검증, main 병합과 배포, 실패 대응 |

## 주요 기능

- ON AIR 위원회별 자막을 브라우저 접속 여부와 관계없이 수집합니다. 채널 목록은 기본 30초마다 갱신합니다.
- 자막을 한국 날짜 기준으로 보관하고, 같은 문장의 초안과 수정본을 최신본으로 합쳐 보여줍니다.
- `자막`·`오디오`·`영상`을 별도 스위치로 제어합니다. 각 카드의 오른쪽에 스위치, 아래쪽에 작은 상태 문구를 배치합니다. 오디오와 영상은 서로 전환되며 이전 재생기의 연결과 버퍼를 정리합니다.
- 영상 모드에서는 채널 아래에 영상이 고정되고 자막 영역이 스크롤됩니다. 자동·수동 화질, 지원 환경의 PIP, 전체화면 자막과 모바일 가로 보기를 제공합니다.
- PC와 모바일 모두 실시간 자막 재생 중 약 3.5초간 조작이 없으면 상·하단 도구가 숨겨집니다. 영상은 계속 보입니다.
- 검색창은 돋보기 버튼으로 펼칩니다. TXT에는 채널·날짜별 문장 최신본과 10분 단위 시간 구분선이 들어갑니다.
- 제목 오른쪽에는 원본 제공처와 영상·음성 직접 재생 및 서버 미저장 안내를 표시합니다.

## 무엇을 저장하나요?

서버는 국회 자막 WebSocket에서 받은 원본 메시지와 문장별 최신본을 SQLite에 저장합니다. 영상·음성 파일은 저장하지 않습니다. 브라우저가 국회 인터넷의사중계시스템의 원본 방송 CDN에서 직접 재생하며, 서버는 자동 화질 선택용 작은 HLS 목록만 생성합니다.

**수집기가 원본에 연결되어 받은 자막만 보관합니다.** 서버 중지·배포·원본 연결 장애 중 놓친 메시지를 소급해서 가져오는 기능은 없습니다. 브라우저 재접속 시 복구되는 것은 이미 서버 DB에 저장된 기록입니다.

## 빠른 실행

Node.js 22.13 이상이 필요하며 Dockerfile과 GitHub Actions는 Node.js 24를 사용합니다. 별도 npm 의존성 설치나 프런트엔드 빌드는 없습니다.

```sh
node --test
node server.mjs
```

브라우저에서 `http://localhost:3000`에 접속합니다. 기본 바인딩은 `0.0.0.0:3000`, DB는 `data/captions.sqlite`입니다. HTML 파일만 직접 열거나 정적 호스팅에 올리면 API가 없어 동작하지 않습니다.

Docker 실행은 다음과 같습니다. 현재 Compose는 외부 네트워크 `proxy`를 사용하므로 먼저 준비해야 합니다.

```sh
docker network inspect proxy
# 네트워크가 없는 경우에만 실행
docker network create proxy
cp .env.example .env
docker compose config
docker compose up -d --build --remove-orphans
```

기존 설치를 업데이트할 때는 [운영 절차](DEPLOY.md)를 먼저 확인하세요. 같은 Compose 프로젝트와 데이터 볼륨을 유지해야 합니다.

## 설정

| 변수 | 기본값 | 적용 위치 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Node 직접 실행의 수신 주소 |
| `PORT` | `3000` | Node 직접 실행의 수신 포트 |
| `DATA_FILE` | `data/captions.sqlite` | Node 직접 실행의 DB 경로; Docker는 `/data/captions.sqlite` |
| `CAPTION_PORT` | `3000` | Compose가 호스트에 공개하는 포트 |
| `BROADCAST_LIST_URL` | 국회 `live_list.asp` 주소 | 직접 실행·Compose |
| `CHANNEL_REFRESH_MS` | `30000` | 직접 실행·Compose의 서버 목록 갱신 간격 |
| `GA_MEASUREMENT_ID` | 직접 실행에서는 빈 값 | 분석 ID; Compose에는 공개 기본 ID가 설정됨 |
| `GA_HOSTNAME` | `soju.day` | 분석 태그가 동작할 호스트명 |

Compose용 `.env.example`에는 포트·방송 목록·갱신 주기가 있습니다. 현재 Compose의 GA 값은 `compose.yaml`에 직접 지정되어 있으므로 분석 설정은 해당 파일을 수정합니다. `GA_MEASUREMENT_ID: ""`이면 분석을 끕니다. 브라우저 호스트명이 `GA_HOSTNAME`과 일치할 때만 태그가 실행됩니다.

`node server.mjs`는 `.env`를 자동으로 읽지 않습니다. 직접 실행에서는 셸 환경변수를 지정하거나 `node --env-file=설정파일 server.mjs`를 사용합니다. 직접 실행 포트는 `PORT`이며 Compose의 `CAPTION_PORT`와 다릅니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.mjs` | 정적 파일, 자막 조회·TXT·SSE, 영상 목록 API |
| `captions.html`, `client.mjs` | 화면, 기록 조회·실시간 수신·검색·자동 숨김 |
| `audio.mjs`, `media.mjs` | 오디오·영상 전환, 화질, 전체화면·PIP·자막 |
| `lib/broadcast-config.mjs`, `lib/channel-manager.mjs` | 방송 목록·주소와 채널별 수집기 관리 |
| `lib/collector.mjs`, `lib/store.mjs` | 원본 WebSocket 수집과 SQLite 저장 |
| `lib/caption-format.mjs`, `lib/video-manifest.mjs` | 자막·날짜 처리와 HLS 목록 생성 |
| `tests/` | 수집·저장·HTTP·클라이언트·미디어 회귀 검사 |

## 현재 제한과 확인 사항

- 영상·음성 싱크가 어긋난다는 보고는 아직 해결되지 않았습니다. 자동 화질 전환 시 원본 간 호환성과 실제 기기의 디코딩 상태를 추가 확인해야 합니다.
- 실시간 영상과 자막은 별도 경로로 전달되며 자동으로 정확한 시간에 맞추지 않습니다. 과거 날짜를 골라도 과거 영상으로 이동하지 않습니다.
- 전체화면·가로 방향 고정·PIP·화면 켜두기·백그라운드 오디오는 브라우저와 기기 조건에 따라 달라집니다. 전체화면 자막은 PIP 창에 포함되지 않습니다.
- 2026-10-19 소스 검증에서 자동 테스트 42개가 통과했습니다. 모의 브라우저 환경을 포함하는 결과이며 실기기 기능과 방송 중 배포의 무손실 수집을 보장하지 않습니다.
- 웹 서버와 자막 수집기는 같은 프로세스에서 실행됩니다. 방송 중 배포하면 수집 공백이 생길 수 있으므로 가능한 한 모든 채널 방송 종료 후 진행합니다.

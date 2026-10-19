# 설치와 운영

현재 소스는 Node.js 프로세스 하나가 웹 화면·API와 채널별 자막 수집기를 함께 실행합니다. 브라우저를 닫아도 수집은 계속되지만 프로세스를 재시작하면 수집 연결도 끊깁니다. 영상·음성은 서버를 거치지 않고 브라우저가 원본 CDN에서 직접 재생합니다.

사용법은 [사용자 안내](SITE_INTRO.md), 저장소 작업과 자동 배포는 [GitHub 배포](GITHUB_DEPLOY.md)를 참고하세요. 이 문서는 저장소 소스 기준이며 운영 배포 완료를 의미하지 않습니다.

## 1. 실행 환경과 파일

Docker Engine과 Compose 플러그인이 있는 Linux 서버를 기준으로 설명합니다. 설치는 [Docker 공식 안내](https://docs.docker.com/engine/install/)를 참고하세요. 직접 실행에는 Node.js 22.13 이상이 필요하며 Dockerfile은 Node.js 24를 사용합니다. 별도 npm 의존성이나 프런트엔드 빌드는 없습니다.

신규 설치는 저장소를 `/opt/caption`에 체크아웃하거나 다음 실행 파일을 함께 복사합니다. 기존 설치는 폴더와 볼륨을 교체하기 전에 데이터 보존 절차를 먼저 확인하세요.

```text
Dockerfile
compose.yaml
.dockerignore
.env.example
package.json
server.mjs
captions.html
client.mjs
audio.mjs
media.mjs
lib/
```

GitHub 자동 배포를 사용할 서버는 파일 복사 방식 대신 `/opt/caption`의 정상적인 Git 체크아웃이 필요합니다.

현재 Compose는 `external: true`, 이름 `proxy`인 네트워크를 사용합니다. 기존 프록시가 사용하는 네트워크가 있는지 먼저 확인하고 없을 때만 만듭니다. 외부 네트워크는 Compose가 자동 생성하지 않습니다. [Docker 네트워크 안내](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-external-network)

```sh
docker network inspect proxy
# 없는 경우에만 실행
docker network create proxy
```

서버는 방송 목록·상세 페이지를 HTTPS로 조회하고 자막 서버로 WebSocket 연결합니다. 현재 국회 자막 서버는 TCP 8091을 사용합니다. 브라우저 쪽에서도 국회 원본 CDN과 HLS.js를 제공하는 jsDelivr에 접속할 수 있어야 합니다.

## 2. 신규 Docker 설치

아래는 새 설치에서 실행하는 명령입니다. 이미 운영 중인 `.env`는 덮어쓰지 않습니다.

```sh
cd /opt/caption
cp .env.example .env
docker compose config
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100 assembly-live-captions
```

기본 접속 주소는 `http://서버IP:3000`입니다. 현재 포트 매핑은 호스트 인터페이스 전체에 포트를 공개하며, 방화벽과 프록시 구성에 맞춰 접근 범위를 정합니다. 컨테이너 내부 Node 서버도 `0.0.0.0:3000`에서 수신합니다.

| 설정 | 적용 방법 |
| --- | --- |
| 외부 공개 포트 | `.env`의 `CAPTION_PORT`; 컨테이너 내부는 3000 유지 |
| 방송 목록 | `.env`의 `BROADCAST_LIST_URL` |
| 서버 목록 갱신 | `.env`의 `CHANNEL_REFRESH_MS`, 기본 30000ms |
| DB | `DATA_FILE=/data/captions.sqlite`, `caption-data:/data` 볼륨 |
| Google Analytics | `compose.yaml`의 `GA_MEASUREMENT_ID`, `GA_HOSTNAME` |

현재 GA 값은 Compose에 직접 지정되어 있어 `.env`에 같은 이름을 추가하는 것만으로 바뀌지 않습니다. 다른 도메인은 Compose의 호스트명과 측정 ID를 함께 변경합니다. 분석을 끄려면 `GA_MEASUREMENT_ID: ""`로 설정합니다. 자동 배포 서버에서 추적 파일을 직접 수정하면 배포가 차단되므로 설정 변경도 저장소에서 검토·반영합니다.

이 서비스에는 별도 로그인 기능이 없습니다. 서버에 접속 가능한 사용자는 저장된 자막을 조회하고 TXT로 받을 수 있습니다.

## 3. 기동과 수집 확인

```sh
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/api/status
curl -fsS http://127.0.0.1:3000/api/config
```

호스트 포트를 변경했다면 URL의 3000도 바꿉니다.

`/healthz`의 HTTP 200은 웹 서버와 DB 조회가 응답한다는 뜻입니다. **모든 채널의 자막 수집 재개를 뜻하지 않습니다.** 현재 다중 채널 모드의 `/api/status`에서 다음을 확인합니다.

| 필드 | 확인할 내용 |
| --- | --- |
| `channels[].onAir` | 수집해야 할 현재 방송 채널 |
| `channels[].collector.state` | 해당 채널이 `connected`인지 |
| `channels[].collector.lastReceivedAt` | 발언·메시지가 있는 동안 갱신되는지 |
| `channels[].loadError` | 방송 주소 조회 실패 여부 |
| `lastError` | 전체 방송 목록 조회 실패 여부 |
| `cursor` | DB에 저장된 전체 수신 메시지 번호가 증가하는지 |

발언이 없으면 자막이 오지 않을 수 있습니다. `connected`만으로 실제 문장 수신을 입증할 수 없으므로 발언 중 수신 시각·DB 번호와 화면 기록을 함께 확인합니다.

목록 조회가 실패하면 이미 유지 중인 수집 연결은 계속 사용합니다. 원본 연결이 끊기면 재시도하며 실패가 이어질수록 대기 시간은 1초부터 최대 60초까지 늘어납니다. 원본 서버의 과거 메시지를 요청하는 기능은 없습니다.

## 4. PC·모바일 확인

브라우저에서 서버 URL로 접속합니다. 같은 PC는 `http://localhost:3000`, 같은 네트워크의 휴대폰은 `http://PC의LAN주소:3000`을 사용합니다. 휴대폰에서 localhost는 휴대폰 자신입니다.

- 채널과 채널 오른쪽 날짜 선택, 과거 기록 조회, 돋보기 검색과 TXT 다운로드를 확인합니다.
- 자막을 잠시 멈췄다 켰을 때 그동안 DB에 저장된 기록을 이어 받는지 확인합니다.
- 오디오와 영상을 번갈아 켜서 이전 재생이 종료되는지, 채널 변경 시 선택한 모드가 이어지는지 확인합니다.
- 영상 모드에서 자동·수동 화질과 상단 영상 고정, 도구 자동 숨김 후 영상 유지 여부를 확인합니다.
- PC와 모바일에서 실시간 자막 수신 중 약 3.5초 유휴 후 도구가 숨겨지고 조작 시 다시 나타나는지 확인합니다.
- 전체화면 자막 겹침·분할·끄기, 종료와 PIP 전환을 지원 환경에서 확인합니다.
- 모바일 가로 전체화면, 잠금 화면 오디오·백그라운드 재생·화면 켜두기는 실제 기기에서 별도로 확인합니다.

API 경로가 `/api/...`로 지정되어 있으므로 현재 구조는 도메인 루트에 설치합니다. 하위 경로나 별도 프런트엔드 도메인을 쓰려면 코드·경로·CORS 구성을 바꿔야 합니다.

## 5. HTTPS와 프록시

도메인·TLS 인증서를 준비하고 루트 경로를 앱에 전달합니다. 호스트에서 실행하는 Nginx의 location 예시는 다음과 같습니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

HTTPS server 블록과 인증서 경로는 기존 프록시 구성에 맞춥니다. 공개 포트를 변경했다면 upstream도 변경합니다. 프록시가 Docker 컨테이너라면 `127.0.0.1`은 그 컨테이너 자신이므로 같은 `proxy` 네트워크의 `http://assembly-live-captions:3000`을 upstream으로 사용합니다.

SSE가 모였다가 한꺼번에 표시되지 않도록 [Nginx proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)을 끕니다. 적용 전 `nginx -t`로 구성을 검사합니다.

화면 켜두기 등 브라우저 기능은 HTTPS 같은 안전한 접속이 필요하며 지원 여부는 기기마다 다릅니다.

## 6. 업데이트와 자막 수집 공백

**방송 중 컨테이너를 교체하면 자막이 누락될 수 있습니다.** 웹 서버와 수집기가 같은 프로세스이므로 기존 컨테이너 종료부터 새 수집기 연결 완료까지 공백이 있습니다. 길이는 종료·기동과 원본 응답에 따라 달라지며 고정된 시간이나 무손실을 보장하지 않습니다.

업데이트는 가능한 한 모든 수집 대상 채널이 방송을 종료한 뒤 진행합니다. 같은 폴더·Compose 프로젝트·데이터 볼륨을 유지하고, 자동 배포 환경에서는 [GitHub 절차](GITHUB_DEPLOY.md)를 따릅니다.

수동 적용이 필요한 환경에서는 검증된 소스를 준비한 뒤 아래 순서로 실행합니다. 빌드는 기존 수집기가 동작하는 동안 미리 할 수 있지만 교체 공백을 없애지는 못합니다.

```sh
cd /opt/caption
docker compose config
docker compose build assembly-live-captions
docker compose up -d --no-build --remove-orphans
docker compose ps
docker compose logs --tail=100 assembly-live-captions
curl -fsS http://127.0.0.1:3000/api/status
```

현재 GitHub 워크플로는 서버에서 `up -d --build --remove-orphans`를 실행합니다. 자동 배포와 수동 갱신을 동시에 진행하지 않습니다. 파일만 교체해도 실행 중인 서버의 정적 파일 캐시 때문에 즉시 반영되지 않을 수 있습니다.

이전 DB 기록 보존과 재시작 중 새 메시지 수집은 다릅니다. DB가 유지되어도 놓친 원본 자막은 복구되지 않습니다. 브라우저 SSE 재전송은 이미 DB에 저장된 범위만 복구합니다. 롤백 역시 재시작을 포함하므로 공백을 추가할 수 있습니다.

방송 중 웹 기능을 바꾸면서 수집을 유지하려면 수집 프로세스를 웹 서버와 분리하는 작업이 필요합니다. 현재 구조에서 컨테이너 두 개를 같은 DB에 붙이는 것만으로 무손실이 보장되지는 않습니다.

## 7. 데이터 보존·이전·백업

자막은 Docker의 `/data/captions.sqlite`와 같은 디렉터리의 WAL 관련 파일에 저장되며 자동 삭제하지 않습니다. `caption-data`는 Compose의 논리 볼륨 이름입니다. 실제 이름은 프로젝트 이름의 영향을 받으므로 폴더나 프로젝트 이름을 바꾸면 다른 빈 볼륨을 연결할 수 있습니다. [Compose 프로젝트 이름](https://docs.docker.com/compose/how-tos/project-name/)

`docker compose down -v`는 데이터 볼륨도 삭제하므로 기록을 보존할 때 실행하지 않습니다. 이미지·소스만 바꾸는 업데이트에서 데이터 볼륨을 교체할 필요는 없습니다.

### 백업

일반 파일 복사로 백업할 때는 수집을 정상 중지하고 `/data` 전체를 매번 새 폴더로 복사합니다. 중지 중 자막은 수집하지 못하므로 방송 종료 후 진행합니다.

```sh
cd /opt/caption
backup_dir="../caption-backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup_dir"
docker compose stop assembly-live-captions
docker compose cp assembly-live-captions:/data/. "$backup_dir/"
docker compose start assembly-live-captions
```

복사 성공과 다시 시작한 수집 상태를 확인합니다. [docker compose cp](https://docs.docker.com/reference/cli/docker/compose/cp/)는 서비스 컨테이너와 로컬 경로 사이의 복사에 사용합니다.

### 직접 실행 DB를 새 Docker 설치로 이전

기존 Node 수집기를 정상 종료한 뒤 DB 디렉터리 전체를 새 서버의 `/opt/caption/data/`에 복사합니다. 다음 절차는 **새 빈 대상 볼륨**에만 적용하며 운영 중인 볼륨을 덮어쓰지 않습니다.

```sh
cd /opt/caption
docker compose build assembly-live-captions
docker compose create assembly-live-captions
docker compose cp ./data/. assembly-live-captions:/data/
docker compose run --rm --no-deps --user root assembly-live-captions chown -R node:node /data
docker compose start assembly-live-captions
```

백업 복구도 정상 중지 상태에서 확인된 백업 전체를 빈 대상 볼륨으로 옮기고 권한을 맞춘 뒤 시작하는 방식입니다. 적용 전 현재 데이터의 별도 백업을 확보하고, 시작 후 과거 날짜·채널 기록과 새 수신을 함께 확인합니다.

## 8. Docker 없이 실행

```sh
node --test
node server.mjs
```

기본값은 `0.0.0.0:3000`, DB는 `data/captions.sqlite`입니다. `0.0.0.0`은 수신 바인딩 주소이며 브라우저에는 localhost나 실제 서버 IP를 입력합니다.

Linux 셸에서 포트와 주소를 바꾸는 예시입니다.

```sh
HOST=0.0.0.0 PORT=3102 node server.mjs
```

PowerShell에서는 다음처럼 설정합니다.

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3102'
node server.mjs
```

`.env`와 `.env.local`은 Node 실행 시 자동으로 읽지 않습니다. 필요하면 `node --env-file=.env.local server.mjs`처럼 파일을 명시하고 직접 실행용 변수인 `HOST`, `PORT`, `DATA_FILE` 등을 넣습니다. Compose용 `CAPTION_PORT`는 직접 실행 포트를 바꾸지 않습니다. 상시 운영에서는 프로세스 재시작 정책과 DB 경로를 고정합니다.

## 9. API와 문제 확인

| 경로 | 용도 |
| --- | --- |
| `/api/config` | 오늘 날짜·방송 목록 등 클라이언트 설정 |
| `/api/channels` | 채널 목록과 수집 상태; `refresh=1`로 수동 갱신 요청 |
| `/api/status`, `/healthz` | 수집 상태·DB cursor; HTTP 성공과 원본 연결은 별도 확인 |
| `/api/dates` | 저장된 날짜 목록 |
| `/api/captions?channel=ID&date=YYYY-MM-DD&mode=clean` | 날짜별 기록; `after`, `limit`로 분할 조회 |
| `/api/events?channel=ID&date=YYYY-MM-DD&since=번호` | SSE 실시간 수신·DB 저장분 재전달 |
| `/api/export?channel=ID&date=YYYY-MM-DD&mode=clean` | TXT 내보내기 |
| `/api/video.m3u8?channel=ID` | 원본 화질 목록을 묶은 HLS 목록 |

표시 모드는 `clean`·`final`·`raw`입니다. TXT는 `raw`에서도 문장 최신본을 내보내며 검색어를 받지 않습니다. JSON 내보내기와 서버의 오디오 중계 API는 없습니다.

자막이 없으면 ON AIR 여부, `loadError`, 원본 WebSocket 연결과 실제 발언 여부를 먼저 확인합니다. 영상·음성이 없으면 브라우저의 자동 재생 차단, CDN 접속과 재생기 로드를 확인합니다. 영상·음성 싱크 문제는 현재 미해결이며 자동 화질 목록의 전환 호환성과 실제 기기 디코딩 상태를 추가 확인해야 합니다.

2026-10-19 기준 자동 테스트 42개가 통과했습니다. 여기에는 모의 DOM·브라우저 API 검사가 포함됩니다. 이전 개발 시점의 테스트 개수나 특정 채널 수신 실험을 현재 운영 상태의 증거로 사용하지 않습니다. 배포 시점의 CI 결과, 실제 채널 수신과 실기기 재생은 각각 확인해야 합니다.

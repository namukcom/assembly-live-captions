# 서버와 클라이언트 배포

이 프로그램은 Node 서버 한 개가 웹 클라이언트와 API를 함께 제공합니다. 프런트엔드 빌드나 별도 앱 설치는 필요 없습니다. PC와 휴대폰에서 같은 서버 URL로 접속합니다. `captions.html`을 파일로 직접 열거나 정적 호스팅에만 올리면 `/api/*`가 없어 동작하지 않습니다.

## 2026-10-16 검증 결과

- Node.js에서 `node --test`: 17개 통과, 실패 0개. 방송 목록·ON AIR 갱신·채널 분리, 기존 DB 마이그레이션, 저장·재시작 유지·문장 수정·SSE 누락 복구·클라이언트 로직을 검사했습니다. 클라이언트 테스트는 모의 DOM 기반입니다.
- 임시 메모리 DB로 실제 HTTP 서버를 실행하여 `/`, 클라이언트 모듈 3개, `/healthz`, `/api/config`의 HTTP 200을 확인했습니다. 기존 DB는 변경하지 않았습니다.
- 실제 목록에서 ON AIR인 행안위·기후노동위를 찾고 두 자막 WebSocket 모두 `connected` 상태가 되는 것을 확인했습니다. 10초 동안 총 26개 원본 메시지를 저장했고 채널별 조회에서 각각 4개, 2개의 정리된 자막을 확인했습니다.
- Docker가 설치되어 있지 않아 이미지 빌드·컨테이너 기동은 미검증입니다. 실제 브라우저 UI와 휴대폰 오디오·잠금 화면 동작도 미검증입니다.
- 국회 생중계 목록을 주기적으로 갱신하고 ON AIR 위원회별 자막 수집기와 240p HLS 오디오 주소를 자동으로 관리합니다.

## 1. Linux 서버 준비와 파일 복사

Docker Engine과 Compose 플러그인이 설치된 Linux 서버를 준비합니다. 설치: https://docs.docker.com/engine/install/

서버에 `/opt/caption` 폴더를 만들고 다음 파일과 폴더를 복사합니다.

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
lib/
```

실행 중인 기존 `data/`는 그대로 복사하지 않습니다. 기존 데이터 이전은 아래 절차를 따릅니다.

## 2. 서버 실행

서버에서 실행합니다.

```sh
cd /opt/caption
cp .env.example .env
docker compose config
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/api/status
curl -fsS http://127.0.0.1:3000/api/config
```

서버는 `.env`의 `BROADCAST_LIST_URL`을 30초마다 요청합니다. `xstat=1`인 ON AIR 위원회마다 `live_play.asp`를 조회하여 자막 WebSocket과 240p 오디오 주소를 가져오고 별도 수집기를 유지합니다. 방송이 종료되면 해당 수집기를 중지하고 새 방송이 시작되면 자동으로 추가합니다.

```env
BROADCAST_LIST_URL=https://assembly.webcast.go.kr/main/service/live_list.asp
CHANNEL_REFRESH_MS=30000
```

목록 요청이 일시적으로 실패하면 기존 채널과 수집 연결을 유지하고 다음 갱신 때 다시 시도합니다.

`/healthz`의 HTTP 200은 웹 서버와 DB가 응답한다는 의미입니다. 원본 자막 연결은 `/api/status`의 `state`가 `connected`인지 확인합니다. 실제 수집 확인은 방송 중 `lastReceivedAt`과 `cursor`가 갱신되는지 확인합니다. 연결 성공만으로 자막 수신까지 보장하지는 않습니다.

서버는 원본 자막 서버 TCP 8091로 나갈 수 있어야 합니다. HTTP 시험 접속에는 서버 방화벽과 클라우드 방화벽의 TCP 3000 허용이 필요합니다.

## 3. 클라이언트 접속

PC 또는 휴대폰 브라우저에서 `http://서버IP:3000`에 접속합니다. 로컬 PC에서 직접 실행 중이면 같은 PC에서는 `http://localhost:3000`, 같은 Wi-Fi의 휴대폰에서는 `http://PC의LAN주소:3000`을 사용합니다. 휴대폰에서 `localhost`는 휴대폰 자신입니다.

- ON AIR 위원회 목록, 채널 변경과 검색이 되는지 확인합니다.
- 상단 채널과 하단 도구는 고정된 상태로 가운데 자막 영역만 스크롤되는지 확인합니다.
- `자막 재생` 스위치를 끈 뒤 다시 켜서 그 사이 기록이 복구되는지 확인합니다.
- 모바일 화면에서 실시간 자막 재생 후 3.5초 동안 조작하지 않았을 때 상단 채널과 하단 도구가 접히고, 화면을 터치하거나 스크롤하면 다시 나타나는지 확인합니다.
- 날짜를 변경했을 때 선택한 채널의 해당 날짜 기록만 표시되는지 확인합니다.
- 새로고침 후 브라우저에 저장된 마지막 채널이 다시 선택되는지 확인합니다.
- 선택한 채널의 TXT를 내려받아 확인합니다.
- `오디오 듣기` 스위치를 켜서 재생합니다. 브라우저에서 원본 방송 CDN으로 직접 연결하므로 클라이언트도 인터넷 접속이 필요합니다. HLS.js 사용 브라우저는 jsDelivr 접속과 방송 CDN의 CORS 허용도 필요합니다.
- 오디오를 켠 상태에서 채널을 변경하고 페이지를 새로고침해도 스위치 상태가 유지되는지 확인합니다. 브라우저 자동 재생 정책으로 음성이 시작되지 않으면 스위치를 껐다가 다시 켭니다.
- 휴대폰 화면 유지 기능은 아래 HTTPS 주소에서 확인합니다. 잠금 화면 오디오와 백그라운드 재생은 실기기에서 확인해야 합니다.

클라이언트의 API 경로가 `/api/...`인 현재 구조에서는 도메인의 루트(`/`)에 배포합니다. 별도 도메인으로 프런트엔드와 API를 나누거나 `/captions/` 같은 하위 경로에 배포하려면 경로와 CORS 처리를 추가해야 합니다.

## 4. 운영용 HTTPS

도메인 DNS를 서버 IP에 연결하고, 해당 도메인의 TLS 인증서를 준비합니다. 현재 서비스 주소인 `soju.day`의 Nginx 예시는 다음과 같습니다.

```nginx
server {
    listen 80;
    server_name soju.day;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name soju.day;
    ssl_certificate /etc/letsencrypt/live/soju.day/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/soju.day/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Nginx의 버퍼링을 꺼야 SSE 자막을 즉시 전달할 수 있습니다. 공식 설명: https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering

HTTPS 프록시를 적용하면 `compose.yaml`의 포트 매핑을 다음처럼 바꾸어 Node 포트를 서버 내부로 제한합니다.

```yaml
    ports:
      - "127.0.0.1:${CAPTION_PORT:-3000}:3000"
```

```sh
docker compose up -d
sudo nginx -t
sudo systemctl reload nginx
```

방화벽에서는 HTTP/HTTPS용 80, 443을 허용합니다. 클라이언트는 `https://실제도메인`으로 접속합니다. 프로그램 자체에는 로그인 기능이 없으므로 접근한 사용자는 저장된 자막을 조회·다운로드할 수 있습니다. 내부 용도라면 VPN이나 프록시 접근 제어를 적용합니다.

## 5. 데이터 이전, 업데이트, 백업

로컬 `data/captions.sqlite`는 Docker 볼륨에 자동으로 이전되지 않습니다. 기존 서버 프로세스를 정상 종료한 뒤 `data/` 전체를 서버의 `/opt/caption/data/`로 복사합니다. 새 서버에서 수집을 시작하기 전에 다음을 실행합니다.

```sh
cd /opt/caption
docker compose create
docker compose cp ./data/. assembly-live-captions:/data
docker compose run --rm --no-deps --user root assembly-live-captions chown -R node:node /data
docker compose up -d
```

이 절차는 새 빈 볼륨에 이전할 때 사용합니다. 이미 운영 중인 볼륨을 덮어쓰지 않습니다.

업데이트는 변경한 파일을 복사한 뒤 실행합니다.

```sh
docker compose up -d --build
docker compose ps
```

볼륨은 컨테이너 재생성 후에도 유지됩니다. 같은 작업 폴더와 Compose 프로젝트 이름을 유지합니다. 공식 설명: https://docs.docker.com/compose/how-tos/project-name/

백업은 수집을 잠시 중지하고 데이터 디렉터리 전체를 복사합니다. 매번 새로운 백업 폴더를 사용합니다.

```sh
docker compose stop
mkdir -p backup-data-20261015
docker compose cp assembly-live-captions:/data/. ./backup-data-20261015
docker compose up -d
```

복구는 수집을 중지하고 백업의 전체 파일을 새 빈 볼륨으로 이전하는 방식으로 진행합니다. `docker compose down -v`는 데이터 볼륨을 삭제하므로 보관할 기록이 있다면 실행하지 않습니다. 서버가 중지된 동안의 자막은 소급 수집하지 못합니다.

## 6. Docker 없이 직접 실행

Node.js 22.13 이상이 필요하며 현재 Dockerfile은 Node.js 24를 사용합니다. 별도 npm 패키지 설치나 클라이언트 빌드는 필요 없습니다.

```sh
node --test
node server.mjs
```

`http://localhost:3000`으로 접속합니다. 직접 실행의 기본 DB는 `data/captions.sqlite`입니다. Linux 상시 운영에서는 systemd 등으로 프로세스를 관리하거나 위 Docker 방식을 사용합니다. `.env`는 Compose가 읽는 설정이며 `node server.mjs`는 자동으로 읽지 않습니다. 직접 실행 시에는 셸 환경변수를 설정하거나 `node --env-file=.env server.mjs`를 사용합니다. 이때 직접 실행 포트 변수는 `PORT`이고 Compose의 `CAPTION_PORT`와 다릅니다.

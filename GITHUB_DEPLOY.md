# GitHub 작업과 자동 배포

저장소는 [namukcom/assembly-live-captions](https://github.com/namukcom/assembly-live-captions)이며, 배포 대상은 `/opt/caption`의 Compose 서비스 `assembly-live-captions`와 [soju.day](https://soju.day)입니다. 실제 동작은 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)을 기준으로 합니다.

설치·네트워크·데이터 이전은 [DEPLOY.md](DEPLOY.md)를 참고하세요. 이 문서는 이미 생성된 저장소의 변경 검토와 배포 운영을 설명합니다.

## 1. 브랜치와 실행 조건

| 작업 | 테스트·Docker 빌드 | 운영 배포 |
| --- | --- | --- |
| 기능 브랜치에 push만 수행 | 현재 워크플로는 실행하지 않음 | 실행하지 않음 |
| Pull Request 생성·갱신 | 실행 | 실행하지 않음 |
| main에 push 또는 PR 병합 | 실행 | 검증 성공과 `DEPLOY_ENABLED=true`일 때 실행 |
| Run workflow로 수동 실행 | 선택한 브랜치에서 실행 | main이고 `DEPLOY_ENABLED=true`일 때만 실행 |

배포 작업의 조건은 PR 이벤트가 아니고, 참조가 `refs/heads/main`이며, 저장소 변수 `DEPLOY_ENABLED`가 문자열 `true`인 경우입니다. 운영 environment의 추가 보호 규칙이 설정되어 있다면 그 승인 조건도 적용됩니다.

**main 병합은 배포로 이어질 수 있습니다.** 운영 반영을 보류할 때는 기능 브랜치와 PR에만 변경을 보관하고 main 병합·main 수동 실행을 하지 않습니다. 문서만 바꿔도 main에 들어가면 같은 워크플로가 실행됩니다.

2026-10-19 문서 정리 시점의 기능 작업 브랜치는 `feature/video-playback-review-20261019`입니다. 이 이름은 해당 작업의 기록이며 앞으로의 모든 작업에서 같은 브랜치를 재사용해야 한다는 뜻은 아닙니다.

## 2. 일반적인 변경 절차

1. 현재 작업 트리와 변경 파일을 확인하고 main이 아닌 기능 브랜치에서 수정합니다.
2. `node --test`, `git diff --check`를 실행하고 설정·DB·키가 포함되지 않았는지 확인합니다.
3. 변경 파일을 명시해서 커밋하고 기능 브랜치에 push합니다.
4. main 대상 PR을 만들고 **Test and build** 작업의 테스트·Docker 이미지 빌드 성공을 확인합니다.
5. 실제 UI나 모바일 기능이 바뀌었다면 재생·전체화면·실기기 확인 결과도 검토합니다.
6. 모든 수집 대상 채널의 방송 종료 여부와 배포 시점을 확인한 뒤 main에 병합합니다.
7. 자동 배포 작업과 운영 수집 상태를 확인합니다.

현재 워크플로에는 main push용 문서 경로 제외 설정이 없습니다. 기능 브랜치 push만으로 CI가 통과했다고 판단하지 말고 해당 PR의 검증 결과를 확인하세요.

`.env`, DB와 배포 키는 커밋하지 않습니다. 현재 저장소의 `.gitignore`는 `.env`, `data/`, `.deploy/`, `artifacts/` 등을 제외하지만 `.env.local`은 공통 규칙에 없습니다. 로컬 설정 파일을 별도 이름으로 만들었다면 커밋 전에 다음으로 제외 여부를 확인하고, 필요하면 로컬 `.git/info/exclude`에 파일명을 추가합니다.

```sh
git status --short
git check-ignore .env.local
```

현재 개발 작업 환경에서의 로컬 제외 설정은 다른 체크아웃으로 자동 복사되지 않습니다.

## 3. 서버 준비 조건

자동 배포를 사용하려면 다음 상태가 준비되어 있어야 합니다.

- `/opt/caption`이 origin을 사용하는 Git 체크아웃이며 main의 이력을 fast-forward로 적용할 수 있어야 합니다.
- 추적 중인 파일에 서버 전용 수정이 없어야 합니다. 서버의 작업 트리가 수정되어 있으면 배포는 중단됩니다.
- 배포 계정이 해당 폴더를 관리하고 Docker·Compose를 실행할 수 있어야 합니다.
- [설치 안내](DEPLOY.md)에 따라 `proxy` 네트워크, Compose 프로젝트와 기존 자막 데이터 볼륨이 준비되어 있어야 합니다.
- GitHub Actions의 SSH 키로 서버에 접속할 수 있고 호스트 키를 신뢰할 수 있는 경로로 확인해야 합니다.

이미 운영 중인 폴더를 다른 이름이나 새 체크아웃으로 교체할 때는 Compose 프로젝트 이름과 실제 볼륨을 먼저 확인합니다. 기존 볼륨이 남아 있어도 새 프로젝트가 다른 빈 볼륨을 연결할 수 있습니다. 이 문서는 운영 폴더 교체를 자동으로 수행하는 명령을 제공하지 않으며 데이터 이전은 별도 운영 절차로 진행합니다.

## 4. 배포 키와 GitHub 설정

새 배포 구성을 준비할 때는 전용 키를 사용합니다. 예를 들어 관리 PC에서 다음과 같이 만들 수 있습니다.

```sh
mkdir -p .deploy
ssh-keygen -t ed25519 -C "github-actions@assembly-live-captions" -f .deploy/github-actions -N ""
```

공개 키 `.deploy/github-actions.pub`는 배포 계정의 authorized_keys에 등록하고, 개인 키는 GitHub Secret에만 등록합니다. 기존 키가 준비되어 있으면 새로 만들 필요가 없습니다.

GitHub 저장소의 **Settings → Secrets and variables → Actions**에서 다음 값을 관리합니다.

| 종류 | 이름 | 내용 |
| --- | --- | --- |
| Secret | `DEPLOY_HOST` | 운영 서버 SSH 주소 |
| Secret | `DEPLOY_USER` | 배포 계정 |
| Secret | `DEPLOY_PORT` | SSH 포트; 비어 있으면 22 사용 |
| Secret | `DEPLOY_SSH_KEY` | 배포 전용 개인 키 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 확인된 서버 호스트 키의 known_hosts 항목 |
| Variable | `DEPLOY_ENABLED` | 배포를 활성화하려면 `true` |

변수가 없거나 `true`가 아니면 테스트와 빌드는 수행하되 운영 배포를 건너뜁니다. 현재 키·변수 값은 저장소 소스에 들어 있지 않으므로 문서만으로 실제 활성화 상태를 확정할 수 없습니다.

호스트 키는 서버의 SSH 호스트 키 지문과 별도 경로로 대조합니다. 기존 설정을 새로 등록하거나 덮어쓰는 작업은 필요한 경우에만 진행합니다.

## 5. 배포 작업의 실제 순서

1. Node.js 24에서 전체 테스트를 실행합니다.
2. CI에서 해당 소스의 Docker 이미지를 빌드합니다.
3. 배포 조건을 만족하면 SSH로 서버에 접속합니다.
4. `/opt/caption`의 Git 작업 트리를 확인하고 이전 커밋을 기록합니다.
5. origin/main을 가져와 Actions가 검증한 정확한 커밋을 fast-forward로 적용합니다.
6. 서버에서 `docker compose up -d --build --remove-orphans`로 이미지를 다시 빌드하고 컨테이너를 갱신합니다.
7. 컨테이너 내부 `/healthz`의 HTTP 성공 여부를 최대 20회, 실패 사이 3초 대기로 확인합니다.
8. 상태 점검에 실패하면 이전 커밋으로 되돌려 다시 빌드·기동하고 워크플로를 실패 처리합니다.

CI에서 만든 이미지를 운영 서버에 그대로 전송하는 방식은 아닙니다. CI와 운영 서버가 각각 빌드합니다. 모든 실행은 같은 concurrency 그룹을 사용하며 진행 중인 실행을 자동 취소하지 않습니다.

`/healthz` 응답 성공은 원본 자막 WebSocket의 연결이나 실제 자막 수신을 검사하지 않습니다. 따라서 Actions가 성공해도 운영 수집 상태를 따로 확인해야 합니다.

## 6. 배포 후 확인

GitHub **Actions → Test and deploy**에서 대상 커밋과 **Test and build**, **Deploy to soju.day**의 결과를 확인합니다. 공개 주소에서도 응답을 조회합니다.

```sh
curl -fsS https://soju.day/healthz
curl -fsS https://soju.day/api/config
curl -fsS https://soju.day/api/status
```

`/api/status`의 각 ON AIR 채널에서 `collector.state`가 `connected`인지, 실제 발언 중 `collector.lastReceivedAt`과 전체 `cursor`가 갱신되는지 확인합니다. 저장된 이전 날짜·채널의 기록도 조회해 같은 DB를 사용하는지 확인합니다.

웹 화면은 새로고침해 제목 안내와 도구 변경을 확인합니다. 이미 열려 있는 탭이 새 코드를 자동으로 로드한다고 가정하지 않습니다.

## 7. 실패·롤백과 수집 공백

현재 자동 롤백은 **컨테이너 상태 점검 실패**에만 구현되어 있습니다. SSH 접속·Git 갱신·이미지 빌드 등 그 이전 단계가 실패했을 때 같은 롤백이 자동으로 수행된다고 가정하지 않습니다. 로그와 실제 서버의 소스·컨테이너 상태를 확인합니다.

자동 롤백은 DB를 과거 시점으로 돌리지 않습니다. 기존 볼륨의 자막 기록은 유지하고 이전 소스로 컨테이너를 다시 기동합니다. 롤백 기동 자체가 실패할 가능성도 있으므로 복구 결과를 확인해야 합니다.

컨테이너 교체와 롤백 중 원본 연결이 끊기면 수집 공백이 생길 수 있습니다. 놓친 메시지는 소급 수집하지 못하며 SSE 재연결도 이를 보완하지 못합니다. 상세한 데이터 보존·백업·수동 적용 절차는 [DEPLOY.md](DEPLOY.md)에 정리되어 있습니다.

영상·음성 싱크 문제와 실제 모바일 전체화면·PIP 호환성은 자동 테스트 통과와 별개의 확인 항목입니다. 알려진 제한은 [README.md](README.md)에 유지합니다.

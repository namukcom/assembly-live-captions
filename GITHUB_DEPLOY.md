# GitHub 공개와 자동 배포

이 문서는 **국회 생중계 자막**(`assembly-live-captions`)을 공개 GitHub 저장소로 운영하고 `main` 브랜치 변경을 [https://soju.day](https://soju.day)에 자동 배포하는 절차입니다.

## 파이프라인 동작

`.github/workflows/deploy.yml`은 다음 순서로 실행됩니다.

1. Pull Request와 `main` push에서 Node.js 24로 전체 테스트를 실행합니다.
2. Docker 이미지를 실제로 빌드해 Dockerfile 오류를 검사합니다.
3. `main` 테스트가 통과하면 GitHub Actions가 전용 SSH 키로 서버에 접속합니다.
4. `/opt/caption`이 수정되지 않은 Git 작업 폴더인지 확인합니다.
5. GitHub Actions가 검사한 정확한 커밋만 fast-forward로 적용합니다.
6. `docker compose up -d --build --remove-orphans`로 컨테이너를 갱신합니다.
7. 컨테이너 내부 `/healthz`를 최대 60초 확인합니다. 실패하면 직전 커밋으로 되돌리고 배포를 실패 처리합니다.

SQLite 자막은 Docker의 기존 `caption-data` 볼륨에 있으므로 소스 갱신과 컨테이너 재생성 후에도 유지됩니다. `docker compose down -v`는 실행하지 않습니다.

## 1. 공개 저장소 만들기

GitHub에서 `assembly-live-captions`라는 **Public** 저장소를 빈 상태로 만듭니다. README, `.gitignore`, 라이선스를 GitHub에서 추가하지 않습니다. 로컬에 이미 해당 파일이 있기 때문입니다.

저장소를 만든 뒤 로컬에서 실행합니다.

```sh
git init -b main
git add .
git commit -m "Initial release of Assembly Live Captions"
git remote add origin https://github.com/namukcom/assembly-live-captions.git
git push -u origin main
```

`reference/`, `.env`, `data/`와 배포 키는 `.gitignore`에 의해 공개 저장소에서 제외됩니다.

## 2. 배포 전용 SSH 키 만들기

관리 PC에서 비밀번호 없는 전용 Ed25519 키를 만듭니다. 이 키를 다른 용도로 재사용하지 않습니다.

```sh
mkdir -p .deploy
ssh-keygen -t ed25519 -C "github-actions@assembly-live-captions" -f .deploy/github-actions -N ""
```

`.deploy/github-actions`는 GitHub Secret에 넣을 개인 키이고 `.deploy/github-actions.pub`는 서버에 등록할 공개 키입니다. `.deploy/`는 Git에서 제외됩니다.

## 3. 서버 배포 계정 준비

서버에서 배포 전용 사용자를 만드는 구성을 권장합니다. Docker 그룹은 호스트에서 높은 권한을 가지므로 이 계정과 SSH 키는 배포에만 사용합니다.

```sh
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo sh -c 'cat >> /home/deploy/.ssh/authorized_keys' < github-actions.pub
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /opt/caption
```

공개 키 파일을 서버로 복사하지 않았다면 `cat .deploy/github-actions.pub`의 한 줄을 서버의 `/home/deploy/.ssh/authorized_keys`에 직접 추가해도 됩니다.

새 그룹 권한은 다음 SSH 로그인부터 적용됩니다.

## 4. 기존 서버 폴더를 Git 체크아웃으로 전환

기존 Docker 볼륨을 삭제하지 않으므로 저장된 자막은 유지됩니다.

```sh
cd /opt
git clone https://github.com/namukcom/assembly-live-captions.git caption-next

cd /opt/caption
docker compose down

cd /opt
sudo mv caption "caption-before-github-$(date +%Y%m%d-%H%M%S)"
sudo mv caption-next caption
sudo chown -R deploy:deploy /opt/caption

cd /opt/caption
docker compose up -d --build --remove-orphans
docker compose ps
curl -fsS https://soju.day/healthz
```

기존 `/opt/caption/.env`를 사용했다면 백업 폴더에서 새 `/opt/caption/.env`로 복사하고 소유자를 `deploy`로 변경한 뒤 Compose를 실행합니다. `.env`는 GitHub에 올리지 않습니다.

## 5. GitHub Secrets 등록

GitHub 저장소의 **Settings → Secrets and variables → Actions**에서 다음 Repository secrets를 등록합니다.

| Secret | 값 |
|---|---|
| `DEPLOY_HOST` | 서버의 SSH 호스트 또는 IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | SSH 포트. 기본 포트라면 `22` |
| `DEPLOY_SSH_KEY` | `.deploy/github-actions` 개인 키 전체 내용 |
| `DEPLOY_KNOWN_HOSTS` | 서버를 신뢰할 수 있는 환경에서 얻은 `ssh-keyscan -H 서버주소` 결과 |

서버 폴더 전환과 Secret 등록을 모두 마친 뒤 같은 화면의 **Variables** 탭에 Repository variable `DEPLOY_ENABLED`를 값 `true`로 등록합니다. 이 변수가 없으면 테스트와 Docker 빌드만 실행하고 서버 배포 작업은 건너뜁니다.

`DEPLOY_KNOWN_HOSTS`는 GitHub Actions가 다른 서버로 잘못 연결되는 것을 막습니다. 가능하면 서버에서 `/etc/ssh/ssh_host_ed25519_key.pub`의 지문을 별도 경로로 확인한 뒤 등록합니다.

GitHub CLI를 사용한다면 다음과 같이 등록할 수 있습니다.

```sh
gh secret set DEPLOY_HOST
gh secret set DEPLOY_USER
gh secret set DEPLOY_PORT
gh secret set DEPLOY_SSH_KEY < .deploy/github-actions
ssh-keyscan -H 서버주소 | gh secret set DEPLOY_KNOWN_HOSTS
```

## 6. 첫 자동 배포 확인

GitHub 저장소의 **Actions → Test and deploy → Run workflow**에서 `main`을 실행합니다. 성공 후 확인합니다.

```sh
curl -fsS https://soju.day/healthz
curl -fsS https://soju.day/api/config
```

이후에는 `main`에 push할 때마다 같은 검증과 배포가 자동으로 실행됩니다. 기능 변경은 별도 브랜치와 Pull Request에서 테스트한 뒤 `main`에 병합하는 방식을 권장합니다.

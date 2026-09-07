# @sqaft/updeps-cli — Proje Planı

## Görev

macOS için `@sqaft/updeps-cli` (komut: `updeps` / `sqaft-updeps`) adında bir global CLI aracı geliştir. Bu araç, yerel makinede farklı klasörlerde duran, birbirini bağımlılık olarak ekleyen yazılım projeleri arasında, bir paketin `git push` (veya ilgili tetikleyici) edilmesinden sonra kendisini bağımlılık olarak kullanan diğer repoların otomatik güncellenmesini, commit atılmasını ve istenirse push edilmesini sağlar.

**Senaryo:** `~/workspace/http` paketini güncelleyip push ediyorum. Bu paketi kullanan `~/workspace/client` reposuna gidilip tanımlanan güncelleme komutlarının (`npm update`, `cargo update`, `pip install`, vb.) çalıştırılması, değişen dosyaların commit'lenmesi, ayara göre push edilmesi ve macOS bildirimi verilmesi gerekiyor.

---

## Temel İlkeler

1. **Yönetilen repolar hiçbir şekilde değiştirilmez.** Repolara özel config dosyası, githook veya gereksiz dependency eklenmez. `@sqaft/updeps-cli` onların varlığından haberdardır, projeler bu araçtan habersizdir.
2. **Tüm tanımlamalar merkezi.** Kullanıcının makinesinde tek bir config dosyası (`~/.config/sqaft-updeps/config.json`).
3. **Yapılandırılabilir Push (Varsayılan: `false`).** Güvenlik gereği varsayılan olarak commit atılır ama push edilmez. Geliştirici isterse konfigürasyondan `push: true` yaparak otomatik push'u aktif edebilir.
4. **Boştayken sıfır maliyet.** Polling yok. Git reflog dosyaları `chokidar` (FSEvents) üzerinden event-driven izlenir.
5. **Dil ve Paket Yöneticisi Bağımsızlığı.** Yalnızca Node.js değil; npm, pnpm, yarn, cargo, pip, poetry, go mod, composer vb. tüm paket yöneticileriyle çalışabilir. Her hedef paket için çalıştırılacak komutlar (`commands`) kullanıcı tarafından belirlenir.
6. **Açık Bağımlılık Haritası (Explicit Dependencies).** Paketler arası bağımlılıklar ve tetikleme ilişkileri `config.json` içinde doğrudan geliştirici tarafından tanımlanır; karmaşık dosya içi otomatik arama ve tahmin mekanizmalarına gerek duyulmaz.

---

## Teknoloji

- **Node.js 22+**, saf ESM JavaScript. **TypeScript kullanma. Build adımı olmasın.** `bin/updeps.js` doğrudan çalışsın.
- Tip ipuçları gerekiyorsa JSDoc yorumları kullan.
- **Bağımlılık minimum.** Tek kabul edilebilir dış bağımlılık: dosya izleme için `chokidar`. Argüman ayrıştırma için Node'un yerleşik `util.parseArgs`'ı, renkli çıktı için `util.styleText` kullan. `commander`, `chalk`, `yargs`, `execa` gibi paketler ekleme.
- Kurulum: `npm link` veya `npm i -g .`
- CLI komut adları: `updeps` (varsayılan) ve `sqaft-updeps`.

---

## Dosya Konumları

```
~/.config/sqaft-updeps/config.json          # tanımlamalar (kullanıcı düzenler)
~/.local/state/sqaft-updeps/state.json      # runtime durumu (araç yazar)
~/.local/state/sqaft-updeps/locks/          # hedef repo kilitleri (mkdir tabanlı)
~/.local/state/sqaft-updeps/logs/updeps.log # log dosyası
~/Library/LaunchAgents/com.sqaft.updeps.daemon.plist
```

XDG değişkenleri (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`) tanımlıysa onlara saygı göster.

---

## Config Şeması

```json
{
  "repos": [
    {
      "path": "~/workspace/http",
      "name": "http",
      "packages": [
        {
          "path": "~/workspace/client",
          "name": "client",
          "triggers": ["push", "fetch"],
          "branches": ["main", "develop"],
          "commands": [
            "npm update {pkgs} --no-audit --no-fund",
            "npm run build"
          ],
          "commitMessage": "chore(deps): bump {bumps}",
          "push": false,
          "commandTimeout": 300
        }
      ]
    }
  ],
  "defaults": {
    "triggers": ["push"],
    "commands": ["npm update {pkgs} --no-audit --no-fund"],
    "commitMessage": "chore(deps): bump {bumps}",
    "commandTimeout": 300,
    "debounceMs": 3000,
    "maxConcurrent": 3,
    "staleLockSec": 900,
    "push": false
  },
  "notifications": true
}
```

- `repos[].path`: İzlenen kaynak repo yolu. `~` genişletmesi desteklenir.
- `repos[].name`: Kaynak repo/paket adı (opsiyonel, verilmezse klasör adı).
- `repos[].packages`: Kaynak repoda değişiklik olduğunda tetiklenecek hedef projeler.
  - `path`: Hedef repo yolu (zorunlu).
  - `name`: Hedef repo adı (opsiyonel, verilmezse klasör adı).
  - `triggers`: Olay listesi (`defaults.triggers`'tan miras alır).
  - `branches`: Kaynak repoda izlenecek branch'ler (`defaults` veya kaynak reponun varsayılan branch'i).
  - `commands`: Hedef dizinde sırayla çalıştırılacak komutlar (`defaults.commands`'tan miras alır).
  - `commitMessage`: Commit mesaj şablonu (`defaults.commitMessage`'tan miras alır).
  - `push`: Commit sonrası `git push` yapılsın mı (`defaults.push`'tan miras alır, varsayılan `false`).
  - `commandTimeout`: Komut zaman aşımı süresi saniye (`defaults.commandTimeout`'tan miras alır).
- Config bozuksa net hata mesajı ver, hangi alanın sorunlu olduğunu söyle. Şema doğrulaması elle yazılsın (`zod` vb. ekleme).

**Komut ve Commit Şablonu Değişkenleri:**
- `{pkg}` — tetikleyen paketin adı
- `{pkgs}` — güncellenen paket(ler)in listesi
- `{sha}` — tetikleyen paketin yeni kısa SHA'sı
- `{bumps}` — commit mesajı için hazır özet (örn. `http@3b4f1a2`)
- `{sourcePath}` — tetikleyen kaynak repo yolu
- `{targetPath}` / `{repoPath}` — hedef repo yolu
- `{sourceBranch}` — tetikleyen kaynak branch
- `{targetBranch}` / `{branch}` — hedef reponun aktif branch'i

---

## Tetikleyiciler

Git reflog dosyaları izlenir ve son satırdaki işlem mesajına bakılarak olay sınıflandırılır.

| Tetikleyici | İzlenen dosya | Reflog mesajı deseni |
|---|---|---|
| `push` | `.git/logs/refs/remotes/<remote>/<branch>` | `update by push` |
| `fetch` | `.git/logs/refs/remotes/<remote>/<branch>` | `fetch ...` |
| `commit` | `.git/logs/refs/heads/<branch>` | `commit`, `commit (amend)`, `commit (initial)` |
| `merge` | `.git/logs/refs/heads/<branch>` | `merge ...`, `pull ...` |
| `manual` | — | sadece `updeps run` |

Reflog satır formatı:
```
<eski-sha> <yeni-sha> Ad <mail> <unix-ts> <tz>\t<mesaj>
```
Yeni SHA ve mesaj bu satırdan alınır, ayrı bir git çağrısına gerek kalmaz.

**Tekrar işleme koruması zorunlu:** `state.json`'da repo başına son işlenen SHA tutulur. Aynı SHA tekrar gelirse sessizce atlanır.

---

## Daemon

- `chokidar` ile, kayıtlı repoların **sadece ilgili reflog dosyaları** izlenir. Repo kökünü recursive izleme yapılmaz.
- İzlenecek path listesi config'teki `triggers` ve `branches` değerlerinden türetilir.
- Config değişince daemon izleme listesini yeniden kurar (config dosyasının kendisi de izlenir).
- launchd agent olarak çalışır (`updeps start`, `stop`, `restart`, `daemon-status`).
- Daemon çökerse launchd `KeepAlive` ile yeniden başlatır.
- Tek instance garantisi: PID dosyası/kilidi.

---

## Runner

Bir kaynak repo için tetikleme geldiğinde:

1. Bu kaynağa bağlı hedef paketler (`packages`) listelenir.
2. Hedef repolar için debounce penceresi (`debounceMs`) uygulanır; art arda gelen tetiklemeler birleştirilir.
3. Hedef repo başına merkezi kilit alınır (`~/.local/state/sqaft-updeps/locks/<path-hash>`). `mkdir` tabanlı atomik kilit. `staleLockSec`'ten eski kilitler temizlenir. Kilit içine PID ve timestamp yazılır.
4. Aynı anda en fazla `maxConcurrent` hedef işlenir.

**Ön kontroller** (başarısızsa atla ve uyar):
- Hedef dizin var mı, geçerli bir git reposu mu?
- Rebase/merge/cherry-pick ortasında mı (`.git/rebase-merge`, `MERGE_HEAD` vb.)?
- Working tree temiz mi? (Kullanıcının kaydedilmemiş değişikliklerini bozmamak için çalışma dizini kirliyse atla).

**Çalıştırma:**
- Hedef dizinde sırayla `commands` çalıştırılır (değişkenler dinamik doldurulur).
- Herhangi bir komut hata verirse (`exit != 0` veya zaman aşımı):
  - Hata loglanır.
  - O adımda yapılmış olabilecek değişiklikler geri alınır (`git reset --hard HEAD` / `git clean -fd`).
  - Kilit serbest bırakılır ve işlem sonlandırılır.

**Sonuç & Commit/Push:**
- Komutlar başarılı bittikten sonra `git status --porcelain` kontrol edilir:
  - Değişiklik yoksa "güncel (unchanged)" sayılır, commit atılmaz.
  - Değişiklik varsa:
    - `git add -A`
    - `git commit -m "<commitMessage>"`
    - Eğer hedef için `push: true` ise:
      - `git push` çalıştırılır.
      - Push başarısız olursa hata loglanır ve kullanıcıya bildirilir.
- `state.json` güncellenir.
- Kilit serbest bırakılır.
- `--dry-run`: Komutları çalıştırır veya simüle eder, dosya değişikliklerini gösterir, commit atmaz ve değişiklikleri geri alır.

---

## State Dosyası

`state.json` şu bilgileri tutar:
- Repo başına son işlenen SHA ve zaman damgası
- Repo başına push bekleyen commit sayısı (`git rev-list --count @{u}..HEAD`) ve son commit mesajı
- Son çalışma özetleri (kaynak repo, hedef paketler, commit/güncel/hata sayıları, zaman)
- Daemon durumu (PID, başlangıç zamanı, izlenen repo sayısı)
- Son hatalar

Atomik yazım (temp dosya + rename) kullanılır.

---

## Bildirimler

- Kaynak repo başına **tek özet bildirim**.
- `terminal-notifier` varsa öncelikli kullanılır, yoksa `osascript` (`display notification`), ikisi de yoksa sessizce atlanır.
- Başarı (`Glass`) ve hata (`Basso`) için farklı ses/başlık.
- `notifications: false` ile tamamen kapatılabilir.

---

## Menü Çubuğu (SwiftBar / xbar)

`updeps menubar` komutu:
- Yalnızca `state.json`'ı okur ve hızlıca formatlar (hiçbir git çağrısı yapmaz).
- Bekleyen push sayısını (`⇡N`), son çalışma özetini, daemon durumunu gösterir.
- `updeps menubar --install` SwiftBar eklentisi olarak kurar.
- Bir çalışma bittiğinde daemon `open -g "swiftbar://refreshplugin?name=updeps"` tetikler.

---

## CLI Komutları

| Komut | İşlem |
|---|---|
| `updeps init` | Örnek bir `config.json` dosyası oluşturur |
| `updeps list` | Kayıtlı kaynak repoları ve altlarındaki hedef paketleri listeler |
| `updeps add <kaynak-path> --target <hedef-path>` | Konfigürasyona yeni kaynak/hedef ilişkisi ekler |
| `updeps remove <kaynak-path> [hedef-path]` | Kaydı siler |
| `updeps graph` | Tanımlı ilişkilerin ASCII bağımlılık ağacını çizer |
| `updeps status` | Daemon durumu, bekleyen push'lar ve son çalışma özeti |
| `updeps run [kaynak] [--dry-run]` | Manuel tetikleme çalıştırır |
| `updeps logs [--follow]` | Logları görüntüler |
| `updeps start` / `stop` / `restart` | launchd daemon kontrolü |
| `updeps doctor` | Sistem sağlık kontrolü (yollar, git repoları, reflog durumu, komutların varlığı) |
| `updeps menubar [--install]` | SwiftBar / xbar eklenti çıktısı ve kurulumu |

---

## Geliştirme Sırası

1. **Çekirdek (Core):** `package.json`, CLI router (`bin/updeps.js`), config yükleme ve doğrulama (`src/config.js`), bağımlılık haritası (`src/graph.js`), `init`, `list`, `graph`.
2. **Runner Motoru:** Hedef repo kilit mekanizması (`src/lock.js`), komut yürütme & şablon değişkenleri (`src/runner.js`), diff & commit & opsiyonel push akışı, `state.json` yazıcı (`src/state.js`), `logger.js`, `updeps run [--dry-run]`.
3. **Daemon & Tetikleyiciler:** Reflog izleyici (`src/watcher.js`), olay sınıflandırıcı (`src/classifier.js`), kuyruk ve debounce (`src/queue.js`), bildirimler (`src/notify.js`), launchd plist yönetimi (`src/daemon.js`).
4. **Görünürlük & Teşhis:** `status`, `doctor`, `logs`, `menubar` eklentisi.

---

## Referans: Mevcut Çözüm (pre-push Script'i)

Bu proje tasarlanırken referans alınan, daha önce kullanılan orijinal `pre-push` githook script'inin tam içeriği:

```bash
#!/usr/bin/env bash
# Bu paket push edildikten SONRA, ayni workspace'teki kardes repolarda
# bagimliligi otomatik gunceller (npm update) ve degisen package-lock.json'i
# commit'ler. Push ETMEZ.
#
# Git'in client-side "post-push" hook'u olmadigi icin: pre-push push'u BLOKLAMADAN
# arkaplana bir is atar; o is yeni commit'in remote'a dustugunu DOGRULAYIP
# ancak ondan sonra guncellemeyi yapar. Push basarisizsa hicbir sey yapmaz.
#
# ES ZAMANLILIK: Birden fazla paket ayni anda push edilirse, arka plan isleri
# AYNI hedef repoyu (ortak dependent) ayni anda guncellemeye calisabilir. Bunu
# onlemek icin her hedef repo, kritik bolum (npm update + git commit) boyunca
# atomik "mkdir" kilidi ile serilestirilir. (macOS'ta flock olmadigi icin mkdir.)
#
# Aktivasyon (npm install'daki "prepare" script'i bunu yapar):
#   git config core.hooksPath .githooks

remote="$1"
repo_root="$(git rev-parse --show-toplevel)"
workspace="$(dirname "$repo_root")"
pkg_name="$(cd "$repo_root" && node -p "require('./package.json').name" 2>/dev/null)"
def_branch="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@')"
def_branch="${def_branch:-main}"
log="$repo_root/.git/update-dependents.log"

# --- Hedef-repo bazli kilit (mkdir tabanli; macOS'ta flock yok) --------------
# Kilit, tek bir hedef repoya ayni anda yalnizca tek is'in dokunmasini saglar.
# Bir is cokerse mtime'i STALE_LOCK_SEC'ten eski olan kilit bayat sayilir ve
# calinir (tek paketlik npm update bundan cok daha kisa surer).
STALE_LOCK_SEC=900
held_lock=""

acquire_lock() {  # $1 = hedef repo dizini
  local ld="$1/.git/update-dependents.lock"
  local waited=0 now age
  while ! mkdir "$ld" 2>/dev/null; do
    now="$(date +%s)"
    # kilit dizininin mtime'i: BSD/macOS (-f %m) veya GNU/Linux (-c %Y)
    age="$(stat -f %m "$ld" 2>/dev/null || stat -c %Y "$ld" 2>/dev/null || echo "$now")"
    if [ "$((now - age))" -ge "$STALE_LOCK_SEC" ]; then
      rm -rf "$ld" 2>/dev/null   # bayat kilit -> temizle, tekrar dene
      continue
    fi
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -ge 300 ] && return 1   # 5 dk bekledik, vazgec
  done
  held_lock="$ld"
  return 0
}

release_lock() {
  [ -n "$held_lock" ] && rm -rf "$held_lock" 2>/dev/null
  held_lock=""
}

# --- macOS bildirimi (osascript her Mac'te hazir; yoksa sessizce atlanir) ----
notify() {  # $1 = ok|fail   $2 = mesaj
  command -v osascript >/dev/null 2>&1 || return 0
  local subtitle="✅ basarili" sound="Glass"
  [ "$1" = fail ] && { subtitle="❌ basarisiz"; sound="Basso"; }
  osascript -e "display notification \"$2\" with title \"deps: $pkg_name\" subtitle \"$subtitle\" sound name \"$sound\"" >/dev/null 2>&1
}

[ -n "$pkg_name" ] || exit 0

# --- Workspace'teki tum "ic" (kardes repo) paket isimlerini tespit et --------
# Bunlar birbirinin transitive git bagimliligi olabilir (orn. app -> client).
# npm update sadece $pkg_name'i verirsek nested kopyayi guncellemez ve npm
# onu hedef repoda BAGIMSIZ olarak kendi HEAD'inden cozer; bu da repolar
# arasinda farkli SHA'larla sonuclanir. Bu yuzden hedefte zaten var olan tum
# ic paketleri tek npm update cagrisinda birlikte guncelliyoruz.
internal_pkgs=()
for sib in "$workspace"/*/; do
  sib="${sib%/}"
  [ -f "$sib/package.json" ] || continue
  [ -d "$sib/.git" ] || continue
  name="$(node -p "require('$sib/package.json').name" 2>/dev/null)"
  [ -n "$name" ] && [ "$name" != "undefined" ] && internal_pkgs+=("$name")
done

while read -r local_ref local_sha _ _; do
  # sadece default branch, silme push'u degil
  [ "$local_ref" = "refs/heads/$def_branch" ] || continue
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue

  (
    # Is yarida olurse tutulan kilidi mutlaka birak.
    trap 'release_lock' EXIT INT TERM

    # 1) Push'un remote'a dustugunu DOGRULA (max ~60s).
    confirmed=0
    for _ in $(seq 1 60); do
      pushed="$(git ls-remote "$remote" "$local_ref" 2>/dev/null | cut -f1)"
      if [ "$pushed" = "$local_sha" ]; then confirmed=1; break; fi
      sleep 1
    done
    if [ "$confirmed" != 1 ]; then
      echo "[deps] push remote'da dogrulanamadi, guncelleme atlandi."
      notify fail "push dogrulanamadi, guncelleme atlandi"
      exit 0
    fi

    echo "[deps] $pkg_name push edildi ($(echo "$local_sha" | cut -c1-7)), dependent'lar taraniyor..."
    committed=0; unchanged=0; failed=0

    # 2) Kardes repolari tara, bu pakete bagimli olanlari guncelle.
    for dep in "$workspace"/*/; do
      dep="${dep%/}"
      [ "$dep" = "$repo_root" ] && continue
      [ -f "$dep/package.json" ] || continue
      [ -d "$dep/.git" ] || continue
      grep -qF "\"$pkg_name\"" "$dep/package.json" || continue

      label="$(basename "$dep")"

      # Bu hedef repoyu ayni anda baska bir hook'un ellememesi icin kilitle.
      # Kilit npm update + commit'i kapsar; iterasyon sonunda birakilir.
      if ! acquire_lock "$dep"; then
        echo "  ! $label: kilit alinamadi (baska guncelleme cok uzun surdu), atlandi"; failed=$((failed+1)); continue
      fi

      # Hedefte zaten mevcut olan diger ic paketleri de guncelleme listesine ekle
      # (nested/transitive kopyalar dahil - orn. app guncellenirken icindeki client).
      update_targets=("$pkg_name")
      for name in "${internal_pkgs[@]}"; do
        [ "$name" = "$pkg_name" ] && continue
        grep -qF "\"node_modules/$name\"" "$dep/package-lock.json" 2>/dev/null && update_targets+=("$name")
      done

      if ! ( cd "$dep" && npm update "${update_targets[@]}" --no-audit --no-fund >/dev/null 2>&1 ); then
        echo "  x $label: npm update basarisiz"; failed=$((failed+1)); release_lock; continue
      fi
      if [ -z "$(git -C "$dep" status --porcelain package-lock.json)" ]; then
        echo "  = $label: guncel"; unchanged=$((unchanged+1)); release_lock; continue
      fi
      bumps=""
      for name in "${update_targets[@]}"; do
        sha="$(grep -A2 -F "\"node_modules/$name\":" "$dep/package-lock.json" | grep -m1 -oE '#[a-f0-9]{7,40}"' | tr -d '#"' | cut -c1-7)"
        [ -n "$sha" ] && bumps="${bumps}${bumps:+, }${name}@${sha}"
      done
      if [ "${UPDATE_DEPENDENTS_DRY_RUN:-0}" = 1 ]; then
        echo "  ~ $label: -> $bumps (dry-run, commit yok)"
        git -C "$dep" checkout -- package-lock.json
        committed=$((committed+1)); release_lock; continue
      fi
      git -C "$dep" add package-lock.json
      if git -C "$dep" commit -m "chore(deps): bump $bumps" -- package-lock.json >/dev/null 2>&1; then
        echo "  + $label: -> $bumps (commit'lendi, push edilmedi)"; committed=$((committed+1))
      else
        echo "  ! $label: lockfile guncellendi ama commit basarisiz"; failed=$((failed+1))
      fi
      release_lock
    done

    echo "[deps] bitti: $committed commit, $unchanged degismedi, $failed hata"
    if [ "$failed" -eq 0 ]; then
      notify ok "$committed commit, $unchanged degismedi"
    else
      notify fail "$failed hata, $committed commit, $unchanged degismedi"
    fi
  )</dev/null >> "$log" 2>&1 &
done

exit 0
```


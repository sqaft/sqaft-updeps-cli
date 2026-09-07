# pkgsync — Proje Prompt'u

## Görev

macOS için `pkgsync` adında bir global CLI aracı geliştir. Bu araç, yerel makinede farklı klasörlerde ve farklı GitHub organizasyonlarında duran, birbirini git dependency olarak kullanan NPM paketleri arasındaki bağımlılık güncellemesini otomatikleştirir.

**Senaryo:** `@acme/core` paketini güncelleyip push ediyorum. Bu paketi dependency olarak kullanan `@acme/client` ve `@beta/dashboard` repolarına gidilip `npm update` çalıştırılması, değişen `package-lock.json`'ın commit'lenmesi ve bana bir macOS bildirimi verilmesi gerekiyor. Bunu elle yapmak istemiyorum.

Aşağıdaki tasarım kararları tartışılarak verildi, bunlara uy. Bir karara katılmıyorsan veya teknik bir engel görüyorsan **kod yazmadan önce söyle**, tartışalım.

---

## Temel ilkeler

1. **Yönetilen repolar hiçbir şekilde değiştirilmez.** Onlara config dosyası, hook, dependency, hiçbir şey eklenmez. `pkgsync` onların varlığından haberdardır, onlar `pkgsync`'ten habersizdir. Tek dokunulan yer: güncelleme sırasında `package-lock.json` ve onun commit'i.
2. **Tüm tanımlamalar merkezi.** Kullanıcının makinesinde tek bir config dosyası. Bu araç kişisel iş akışının parçası, projenin parçası değil.
3. **Push edilmez.** Araç dependent repoda commit atar, asla push etmez. Push kararı her zaman kullanıcıda.
4. **Boştayken sıfır maliyet.** Polling yok. Dosya izleme FSEvents üzerinden event-driven olmalı. `usePolling` asla açılmaz.
5. **Graph elle yazılmaz.** Kullanıcı sadece repo yollarını tanımlar; paket adları ve aralarındaki bağımlılık ilişkisi `package.json`'lardan çıkarılır.

---

## Teknoloji

- **Node.js 22+**, saf ESM JavaScript. **TypeScript kullanma. Build adımı olmasın.** `bin/pkgsync.js` doğrudan çalışsın.
- Tip ipuçları gerekiyorsa JSDoc yorumları kullan.
- **Bağımlılık minimum.** Tek kabul edilebilir dış bağımlılık: dosya izleme için `chokidar`. Argüman ayrıştırma için Node'un yerleşik `util.parseArgs`'ı, renkli çıktı için `util.styleText` kullan. `commander`, `chalk`, `yargs`, `execa` gibi paketler ekleme.
- Kurulum: `npm link` veya `npm i -g <path>`. **npm'e yayınlanmayacak.**
- Kod okunabilir ve yorumlu olsun; bu araç bakımını kullanıcının kendisinin yapacağı bir şey.

---

## Dosya konumları

```
~/.config/pkgsync/config.json          # tanımlamalar (kullanıcı düzenler)
~/.local/state/pkgsync/state.json      # runtime durumu (araç yazar)
~/.local/state/pkgsync/locks/          # hedef repo kilitleri
~/.local/state/pkgsync/logs/pkgsync.log
~/Library/LaunchAgents/com.pkgsync.daemon.plist
```

XDG değişkenleri (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`) tanımlıysa onlara saygı göster.

---

## Config şeması

```json
{
  "repos": [
    { "path": "~/Projects/acme/core" },
    { "path": "~/Projects/acme/client" },
    {
      "path": "~/Work/clients/beta/dashboard",
      "triggers": ["push", "fetch"],
      "branches": ["main", "develop"],
      "commands": [
        "npm update {pkgs} --no-audit --no-fund",
        "npm run build"
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
    "staleLockSec": 900
  },
  "exclude": [["@acme/core", "@beta/dashboard"]],
  "extraEdges": [["@acme/core", "@legacy/thing"]],
  "notifications": true
}
```

- `repos[].path` dışındaki her alan opsiyonel, `defaults`'tan miras alır.
- `branches` verilmezse repo'nun default branch'i kullanılır (`git symbolic-ref refs/remotes/origin/HEAD`, bulunamazsa `main`).
- `exclude`: `[kaynak, hedef]` çiftleri, otomatik çıkarılan graph'tan bu kenarı siler.
- `extraEdges`: `package.json`'dan çıkarılamayan kenarları elle ekler.
- `~` genişletmesi her yolda desteklenmeli.
- Config bozuksa net hata mesajı ver, hangi alanın sorunlu olduğunu söyle. Şema doğrulaması elle yazılsın, `zod` vb. ekleme.

**Komut şablonu değişkenleri:**
- `{pkgs}` — güncellenecek paketlerin boşlukla ayrılmış listesi
- `{pkg}` — tetikleyen paketin adı
- `{sha}` — tetikleyen paketin yeni SHA'sı (kısa)
- `{repoPath}` — hedef repo yolu
- `{branch}` — hedef repo'nun aktif branch'i
- `{bumps}` — commit mesajı için, `@acme/core@a3f9c21, @acme/client@b7e2d10` formatında

---

## Graph çıkarımı

Her kayıtlı repo için `package.json` okunur:
- `name` → paket adı
- `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` içinde başka bir **kayıtlı** paketin adı geçiyorsa kenar oluşur

**Metin araması yapma, JSON parse et.** (Mevcut çözümde `grep -qF "\"$pkg_name\""` kullanılıyordu, isim benzerliğinde yanlış eşleşiyor.)

Sonra `exclude` çıkarılır, `extraEdges` eklenir. Cycle tespit edilirse uyar ve kenarı kırarak devam et, çökme.

`package.json`'ı okunamayan veya `name` alanı olmayan repo için net uyarı ver, sessizce atlama.

---

## Tetikleyiciler

Git reflog dosyaları izlenir ve son satırdaki işlem mesajına bakılarak olay sınıflandırılır.

| Tetikleyici | İzlenen dosya | Reflog mesajı deseni |
|---|---|---|
| `push` | `.git/logs/refs/remotes/<remote>/<branch>` | `update by push` |
| `fetch` | `.git/logs/refs/remotes/<remote>/<branch>` | `fetch ...` |
| `commit` | `.git/logs/refs/heads/<branch>` | `commit`, `commit (amend)`, `commit (initial)` |
| `merge` | `.git/logs/refs/heads/<branch>` | `merge ...`, `pull ...` |
| `checkout` | `.git/logs/HEAD` | `checkout: moving from ... to ...` |
| `manual` | — | sadece `pkgsync run` |

Reflog satır formatı:
```
<eski-sha> <yeni-sha> Ad <mail> <unix-ts> <tz>\t<mesaj>
```
Yeni SHA ve mesaj bu satırdan alınır, ayrı bir git çağrısına gerek yok.

**Bilinmesi gerekenler:**
- `git pull` remote-tracking ref'i fetch adımıyla günceller, yani orada `fetch ...` olarak görünür. `pull`'u ayrı bir tetikleyici olarak sunma; `fetch` "uzaktan yeni bir şey geldi" anlamına gelsin.
- `commit` tetikleyicisi git dependency'ler için işe yaramaz (lokal commit henüz remote'ta değil, `npm update` göremez). `file:` bağımlılıkları veya özel build komutları için anlamlı. `doctor` bu kombinasyonu tespit edip uyarsın.
- Reflog varsayılan olarak açıktır ama `core.logAllRefUpdates` kapatılmış olabilir. `doctor` kontrol etsin.

**Tekrar işleme koruması zorunlu:** `state.json`'da repo başına son işlenen SHA tutulur. Aynı SHA tekrar gelirse sessizce atlanır. Aynı repoda hem `push` hem `fetch` tanımlıysa bu koruma olmadan çift çalışma olur.

---

## Daemon

- `chokidar` ile, kayıtlı repoların **sadece ilgili reflog dosyaları** izlenir. Repo kökünü recursive izleme, `node_modules` olay yağmuru yaratır.
- İzlenecek path listesi config'teki `triggers` değerlerinden türetilir; hiçbir repoda `checkout` yoksa `.git/logs/HEAD` hiç izlenmez.
- Config değişince daemon izleme listesini yeniden kursun (config dosyasının kendisi de izlensin).
- launchd agent olarak çalışır. `pkgsync start` plist'i üretip `launchctl bootstrap` yapsın; `stop`, `restart`, `daemon-status` komutları olsun.
- Daemon çökerse launchd `KeepAlive` ile yeniden başlatsın.
- Tek instance garantisi: PID dosyası veya lock.

---

## Runner

Bir kaynak paket için tetikleme geldiğinde:

1. Graph'tan dependent'lar bulunur, **topolojik sırayla** işlenir.
2. Her hedef repo için debounce penceresi (`debounceMs`) uygulanır; art arda gelen tetiklemeler birleştirilir.
3. Hedef repo başına merkezi kilit alınır (`~/.local/state/pkgsync/locks/<path-hash>`). `mkdir` tabanlı atomik kilit. `staleLockSec`'ten eski kilitler bayat sayılıp temizlenir. Kilit dizini içine PID ve zaman damgası yaz, teşhis için.
4. Aynı anda en fazla `maxConcurrent` hedef işlenir.

**Ön kontroller** (herhangi biri başarısızsa atla ve raporla, asla zorlama):
- Yol var mı, git repo'su mu
- Rebase/merge/cherry-pick ortasında mı (`.git/rebase-merge`, `.git/rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`)
- Aktif branch, izin verilen `branches` listesinde mi
- Working tree temiz mi (`package-lock.json` hariç). **Asla stash'leme.**
- `node_modules` var mı; yoksa `npm update` yerine `npm install` gerekir

**Güncelleme:**
- Hedefin `package-lock.json`'ında geçen **tüm kayıtlı paketleri** topla ve tek `npm update` çağrısında birlikte güncelle. Sadece tetikleyen paketi güncellersen npm nested/transitive kopyaları kendi HEAD'lerinden bağımsız çözer ve repolar arası SHA tutarsızlığı çıkar. (Bu, mevcut çözümdeki en değerli bulgu.)
- Lockfile'ı JSON olarak parse et: `packages["node_modules/<name>"].resolved` alanı `git+ssh://...#<sha>` formatında, SHA oradan alınır. Regex/grep kullanma, lockfile v2/v3 farkı var.

**Git spec tespiti:**
- `github:org/repo`, `#main`, `#semver:^1.0.0` → `npm update` SHA'yı ilerletir, sorun yok.
- `#<40 karakter sha>` (sabit pin) → `npm update` **ilerletmez**. Bu durumu tespit et, o paketi atla ve kullanıcıya "sabit SHA'ya pinlenmiş, otomatik güncellenemez" uyarısı ver. `doctor` da bunu raporlasın.

**Sonuç:**
- `package-lock.json` değişmediyse "güncel" say, commit atma.
- Değiştiyse config'teki `commitMessage` şablonuyla **sadece `package-lock.json`'ı** commit et. Başka dosya commit'e girmesin.
- Herhangi bir komut başarısız olursa `git checkout -- package-lock.json` ile geri al.
- `commandTimeout` aşılırsa süreci öldür, hata say.
- `--dry-run`: değişikliği hesapla, göster, commit etme, lockfile'ı geri al.

---

## State dosyası

`state.json` şu bilgileri tutsun (menü çubuğu ve `status` bunu okur, kendisi hesaplama yapmaz):

- Repo başına son işlenen SHA ve zaman damgası
- Repo başına **push bekleyen commit sayısı** (`git rev-list --count @{u}..HEAD`, her çalışma sonunda hesaplanıp yazılır) ve son bump commit'inin mesajı
- Son çalışma özetleri: kaynak paket, commit/değişmedi/hata sayıları, zaman
- Daemon durumu: PID, başlangıç zamanı, izlenen repo sayısı
- Son hatalar

Atomik yazım (temp dosya + rename) kullan, yarım yazılmış state okunmasın.

---

## Bildirimler

- Kaynak paket başına **tek özet bildirim**. 10 dependent için 10 bildirim atma.
- `terminal-notifier` varsa onu kullan (tıklanabilir, log açılabilir); yoksa `osascript` ile `display notification`'a düş; ikisi de yoksa sessizce atla.
- Başarı ve hata için farklı ses/başlık. Mevcut çözümdeki `Glass` / `Basso` ayrımı iyi çalışıyordu.
- `notifications: false` ile tamamen kapatılabilsin.

---

## Menü çubuğu (SwiftBar / xbar)

`pkgsync menubar` komutu, plugin çıktısını üretir.

**Kritik kural:** Bu komut **hiçbir iş yapmaz**. Git çağırmaz, repo taramaz, sadece `state.json`'ı okuyup formatlar. 30 saniyede bir 20 repoda git çalıştırmak kabul edilemez.

Çıktı formatı:

```
⇡2
---
Push bekleyen (2)
  @acme/client · 1 commit · 2s önce | bash=... param1=open param2=~/Projects/acme/client
  @acme/app · 1 commit · 2s önce
---
Son çalışma: @acme/core
  2 commit, 1 değişmedi, 0 hata · 14:32
---
Drift kontrolü çalıştır | bash=<pkgsync-yolu> param1=check terminal=false refresh=true
Logları aç | bash=...
---
Daemon: çalışıyor (12 repo)
Duraklat | bash=...
```

- İkon durumları: boşta sade, bekleyen varsa `⇡N`, hata varsa `⚠`.
- SwiftBar SF Symbols destekliyor (`| sfimage=`), xbar desteklemiyor. İkisiyle uyumlu kal, emoji/metin fallback koy.
- `pkgsync menubar --install` plugin dosyasını `~/Library/Application Support/SwiftBar/pkgsync.30s.sh` konumuna yazsın; SwiftBar kurulu değilse nasıl kurulacağını söylesin.
- Bir çalışma bittiğinde daemon `open -g "swiftbar://refreshplugin?name=pkgsync"` göndersin ki menü anında güncellensin.

---

## CLI komutları

| Komut | İş |
|---|---|
| `pkgsync scan <dizin...>` | Dizinleri gezip `.git` + `package.json` olan repoları bulur, aralarındaki ilişkiyi gösterir, hangilerinin ekleneceğini sorar. `node_modules` ve `.git` içine girmez, derinlik sınırı olsun. İlişkisiz repoları varsayılan olarak dışarıda bırakır. Tekrar çalıştırıldığında sadece yenileri sorar. |
| `pkgsync add <path>` | Tek repo ekler |
| `pkgsync remove <path\|paket>` | Kaydı siler |
| `pkgsync list` | Kayıtlı repolar, paket adları, tetikleyiciler |
| `pkgsync graph` | ASCII bağımlılık ağacı |
| `pkgsync status` | Asıl arayüz: daemon durumu, push bekleyenler, son çalışma özeti |
| `pkgsync check` | Drift raporu: her dependent'ın lockfile'daki SHA'sını kaynak paketin remote HEAD'iyle karşılaştırır (`git ls-remote`), geride kalanları listeler. Hiçbir şeyi değiştirmez. |
| `pkgsync run <paket> [--dry-run]` | Elle tetikleme |
| `pkgsync logs [--follow]` | Log tail |
| `pkgsync start` / `stop` / `restart` | launchd agent yönetimi |
| `pkgsync doctor` | Sağlık kontrolü |
| `pkgsync menubar [--install]` | SwiftBar plugin çıktısı / kurulumu |

**`doctor` neleri kontrol etsin:**
- Kayıtlı yollar hâlâ yerinde mi, hâlâ git repo'su mu
- `package.json`'daki paket adları config'te varsayılanla eşleşiyor mu (paket yeniden adlandırılmış olabilir)
- Reflog açık mı (`core.logAllRefUpdates`)
- Daemon ayakta mı, plist yerinde mi
- Sabit SHA'ya pinlenmiş git dependency'ler var mı
- `commit` tetikleyicisi tanımlı ama repo git dependency kullanıyor mu (anlamsız kombinasyon uyarısı)
- Bayat kilit dosyaları var mı
- `terminal-notifier` / SwiftBar kurulu mu

---

## Loglama

- Merkezi log dosyası, satır başına zaman damgası ve seviye.
- Komut çıktıları (stdout/stderr) log'a yazılsın, hata ayıklama için gerekli.
- Basit boyut tabanlı rotasyon (örn. 5 MB, 3 dosya).

---

## Geliştirme sırası

Her aşamayı tamamlayıp bana göstererek ilerle, hepsini bir seferde yazma.

1. **Çekirdek:** config okuma/doğrulama, repo kaydı, graph çıkarımı, `add` / `remove` / `list` / `graph` / `scan`
2. **Runner:** ön kontroller, kilit, npm güncelleme, lockfile parse, commit, `run --dry-run`, loglama, state yazımı
3. **Daemon:** reflog izleme, tetikleyici sınıflandırma, debounce, tekrar işleme koruması, launchd agent, bildirimler
4. **Görünürlük:** `status`, `check`, `doctor`, `logs`, menü çubuğu plugin'i

---

## Referans: mevcut çözüm

Kullanıcı şu an tek bir workspace içinde çalışan bir `pre-push` hook'u kullanıyor (dosyayı ekleyebilir). Yeni araç onun yerini alacak. Taşınması gereken kazanımlar:

- Hedef repo başına kilit, bayat kilit temizliği
- Hedefte mevcut tüm iç paketleri tek `npm update` çağrısında toplama
- `--dry-run` modu
- Push edilmeden commit atma davranışı
- Başarı/hata için ayrı bildirim sesi

Bırakılacaklar:
- `workspace = repo'nun üst dizini` varsayımı (tüm sorunun kaynağı)
- `grep` ile package.json içinde isim arama
- `pre-push` + arka planda `git ls-remote` polling ile push doğrulama (reflog zaten kesin sinyal veriyor)
- Repo başına hook kurulumu ve `prepare` script'i bağımlılığı

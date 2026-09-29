# @sqaft/updeps-cli

Bir paket `git push` edildiğinde, onu bağımlılık olarak kullanan diğer repolara
gidip tanımladığın komutları çalıştıran, değişen kilit dosyalarını commit'leyen,
dil ve paket yöneticisi bağımsız macOS CLI aracı + arka plan servisi.

Yönetilen repolara hiçbir şey eklenmez — ne githook, ne config dosyası, ne
bağımlılık. Tüm tanım tek bir merkezi dosyada durur; araç repoların varlığını
bilir, repolar araçtan habersizdir.

---

## Nasıl çalışır

1. Bir daemon, tanımladığın kaynak repoların yalnızca ilgili git reflog
   dosyalarını izler (`.git/logs/refs/remotes/origin/<branch>` — polling yok,
   FSEvents).
2. Bir kaynak repoya push ettiğinde git bu dosyayı `update by push` mesajıyla
   günceller → daemon olayı yakalar. (Push başarısızsa dosya güncellenmez, hiçbir
   şey olmaz — ekstra doğrulamaya gerek yok.) Daemon kapalıyken (restart,
   çökme, `updeps stop`) yapılan push'lar kaybolmaz: her reflog dosyasının son
   görülen ucu `state.json`'da tutulur, `updeps start`'ta mevcut uçla
   karşılaştırılır ve fark varsa normal akışa aynen bir canlı olay gibi sokulur.
3. Kısa bir `debounceMs` penceresi sonrası, o kaynağa bağlı **her hedef repo**
   için sırayla (tüm sistemde aynı anda tek iş):
   - hedef repo kilitlenir (`mkdir` tabanlı, macOS'ta `flock` yok),
   - `commands` çalıştırılır,
   - **yalnızca komutun değiştirdiği dosyalar** commit'lenir (senin kaydedilmemiş
     işine dokunulmaz),
   - `push: true` ise push edilir (varsayılan: hayır).
4. Kaynak başına tek bir macOS bildirimi: `3 commit, 2 güncel, 0 hata`.

---

## Kurulum

```bash
git clone <repo> && cd sqaft-updeps-cli
npm install
npm link            # updeps ve sqaft-updeps komutlarını kurar
```

Node.js 22+ ve macOS gerektirir.

---

## Hızlı başlangıç

```bash
updeps init                 # ~/.config/sqaft-updeps/config.json oluşturur
# (config'i düzenle)
updeps doctor               # yolları, git remote'larını, komutları kontrol et
updeps graph                # bağımlılık ağacını ve türetilen {pkgs} listelerini gör
updeps run <kaynak> --dry-run   # commit atmadan dene
updeps start                # launchd daemon'ı başlat
updeps status               # durum, çalışan iş + kuyruk, açık hatalar
```

---

## Konfigürasyon

Konum: `~/.config/sqaft-updeps/config.json` (`XDG_CONFIG_HOME`'a saygılı).

Daemon çalışırken bu dosyayı düzenlersen değişiklik **otomatik algılanır ve
yeniden yüklenir** — `updeps restart` gerekmez. (Geçersiz JSON / doğrulama
hatası olursa eski ayarlar korunur ve log'a yazılır.) `updeps init`,
`updeps add`, `updeps remove` ile yapılan değişiklikler de aynı şekilde canlı
uygulanır.

Bilinmeyen bir alan adı (`comands` gibi bir yazım hatası) config'i geçersiz
kılmaz — sessizce yok sayılıp varsayılana düşmek yerine `updeps doctor`
çıktısında ve daemon log'unda uyarı olarak görünür.

```jsonc
{
  "notifications": true,
  "defaults": {
    "triggers": ["push"],                 // push | fetch | commit | merge
    "branches": [],                       // boş = kaynağın varsayılan branch'i (origin/HEAD)
    "commands": ["npm update {pkgs} --no-audit --no-fund"],
    "commitMessage": "chore(deps): bump {bumps}",
    "commandTimeout": 300,                // saniye
    "debounceMs": 3000,
    "staleLockSec": 900,                  // bu kadar eski kilit "bayat" sayılır
    "waitTimeoutSec": 0,                  // 0 = kilit için sınırsız bekle
    "dirtyPolicy": "selective",           // selective | skip
    "push": false,
    "coalesce": true                      // bkz. "Eşzamanlılık"
  },
  "repos": [
    {
      "path": "~/workspace/acme/acme-api",
      "name": "@acme/api",                // paket yöneticisindeki bağımlılık adı ({pkg}/{pkgs})
      "branches": ["main"],               // opsiyonel, kaynağa özel
      "packages": [
        {
          "path": "~/workspace/acme/acme-worker",
          "name": "acme-worker",          // sadece etiket (log/bildirim); verilmezse klasör adı
          "commands": ["yarn upgrade {pkgs}"],
          "commitMessage": "deps: {bumps}",
          "push": false,
          "commandTimeout": 300,
          "dirtyPolicy": "selective"
        }
      ]
    }
  ]
}
```

Gerçek, çok organizasyonlu bir örnek için: [`examples/config.json`](examples/config.json)
(`updeps init --example` ile bunu yazar).

### `name` alanının iki anlamı

- **`repos[].name`** → paket yöneticisindeki bağımlılık kimliği. `{pkg}` ve
  `{pkgs}` bununla doldurulur. Verilmezse klasör adı.
- **`repos[].packages[].name`** → yalnızca insan-okunur etiket (log, bildirim,
  CLI çıktısı). Verilmezse klasör adı.

### `{pkgs}` nasıl türetilir

Bir hedef repo için `{pkgs}`, **o hedefi bağımlı olarak listeleyen tüm
kaynakların** adlarıdır (config sırasıyla). Örneğin `examples/config.json`'da
`umbrella-machine` dört ayrı kaynağa bağlı; hangisi push edilirse edilsin komut:

```
yarn upgrade @umbrella/api @umbrella/mobile-client @umbrella/web-client @umbrella/realtime
```

Böylece nested/transitive kopyalar da tek çağrıda güncellenir ve repolar arası
SHA tutarsızlığı oluşmaz — lockfile parse etmeye gerek kalmadan.

### Şablon değişkenleri

`commands` ve `commitMessage` içinde:

| Değişken | İçerik |
|---|---|
| `{pkg}` | Tetikleyen kaynağın adı |
| `{pkgs}` | Türetilen paket listesi (komutta shell-quote'lu, commit mesajında virgüllü) |
| `{sha}` | Tetikleyen commit'in 7 haneli SHA'sı |
| `{bumps}` | `{pkg}@{sha}`; aynı hedefe birleşen (coalesce) birden çok kaynak varsa `a@sha1, b@sha2` |
| `{sourcePath}` · `{sourceBranch}` | Kaynak repo yolu / branch'i |
| `{targetPath}` · `{targetBranch}` | Hedef repo yolu / aktif branch'i |

### `dirtyPolicy`

- **`selective`** (varsayılan): hedef repoda kaydedilmemiş değişikliğin olsa bile
  çalışır; komut öncesi/sonrası `git status` farkı alınır ve **yalnızca komutun
  dokunduğu dosyalar** stage'lenip commit'lenir. Senin işine dokunulmaz.
  `git add -A` hiçbir zaman kullanılmaz.
- **`skip`**: hedef working tree kirliyse hiç dokunma, "atlandı" bildir.

Komut hata verirse, yalnızca **komut öncesi temiz olan** ve komutun değiştirdiği
takipli dosyalar geri alınır. `git reset --hard` / `git clean -fd` hiçbir koşulda
çalıştırılmaz.

### `push: true` ve zincirleme

`push: true` yaparsan hedefe atılan commit push edilir; bu da o hedefi kaynak
olarak listeleyen başka repoları tetikler (zincirleme). Genellikle istenmeyen bir
durumdur; varsayılan `false`. `updeps graph` ve `updeps doctor` bağımlılık
döngülerini (cycle) uyarır.

---

## Komutlar

| Komut | İşlev |
|---|---|
| `updeps init [--force] [--example]` | Örnek konfigürasyon oluşturur |
| `updeps list` | Kaynak repoları ve hedeflerini listeler |
| `updeps graph` | ASCII bağımlılık ağacı + döngü kontrolü + türetilen `{pkgs}` listeleri |
| `updeps add <kaynak> --target <hedef> [--name N] [--target-name N] [--command "..."]` | Config'e ilişki ekler |
| `updeps remove <kaynak> [hedef]` | İlişkiyi veya kaynağı siler |
| `updeps run [kaynak] [--target X] [--dry-run]` | Manuel çalıştırma (tetikleyici/branch filtrelerini atlar) |
| `updeps retry --failed` \| `updeps retry <hedef>` | Açık hataları yeniden dener |
| `updeps status [-w/--watch]` | Şu an ne çalışıyor + kuyruktaki hedefler, **açık hatalar**, son çalışmalar. `--watch` = saniyede bir yenilenen canlı görünüm |
| `updeps history [--failed] [--repo X] [--since 2d] [-n N] [--json]` | Tüm işlem geçmişi (kalıcı JSONL günlüğünden) |
| `updeps show <grup-id \| hedef \| kaynak>` | Bir çalışmanın tam detayı: komutlar, çıktı, commit SHA, hata çıktısı |
| `updeps logs [-f] [-n N]` | Ham log |
| `updeps doctor` | Sistem sağlık kontrolü |
| `updeps start` · `stop` · `restart` | launchd daemon kontrolü |
| `updeps menubar [--install]` | SwiftBar / xbar menü çubuğu eklentisi |
| `updeps reset [--yes] [--keep-daemon]` | Config **hariç** tüm veriyi siler: kuyruk, açık hatalar, geçmiş (journal), ham loglar, işlenmiş SHA takibi, kilitler. Daemon çalışıyorsa bellekteki kuyruğu da boşaltmak için yeniden başlatılır (`--keep-daemon` ile atlanır). `--yes` onayı geçer. Menü çubuğunda **Bakım › Verileri temizle** butonu da aynı işi yapar. |

---

## Eşzamanlılık

Tüm sistemde **aynı anda tek iş** çalışır (global seri kuyruk). Bir kaynağa
ardışık push'lar `debounceMs` içinde birleşir. Kuyrukta henüz başlamamış, aynı
hedefe ait bir iş varsa ve o hedefin `coalesce` ayarı açıksa (varsayılan
`true`) yeni tetikleme ona eklenir (ayrı iş açılmaz) — `{pkgs}` zaten tüm
kaynakları kapsadığı için ikinci çalıştırma çoğu zaman no-op olurdu; birleşen
işte `{bumps}` her kaynağı ayrı ayrı listeler (`a@sha1, b@sha2`). `coalesce:
false` yapılırsa aynı debounce penceresinde biriken her kaynak için hedef ayrı
ayrı çalıştırılır. İki kaynağın aynı hedef için **farklı** komut/branch/vb.
tanımladığı durumlarda (örn. biri `branches: ["main"]`, diğeri farklı bir
`commands` listesi) birleştirme hiçbir zaman olmaz — her biri kendi ayarıyla
ayrı iş olarak çalışır, böylece bir kaynağın ayarı diğerine sızmaz. Çalışmakta
olan bir hedefe yeni olay gelirse iş bittikten sonra tekrar sıraya alınır.

---

## İzleme ve hata takibi

Her işlem `~/.local/state/sqaft-updeps/journal.jsonl` dosyasına tek satır JSON
olarak, kalıcı biçimde yazılır (5MB'da `.1`'e döner). Üç yerden görürsün:

- **`updeps status`** — şu an ne çalışıyor + kuyruktaki hedefler, **çözülmemiş
  açık hatalar**, son 10 çalışma. `--watch` ile terminal penceresini açık
  bırakıp canlı izlersin.
- **`updeps history --failed --since 3d`** — filtreli geçmiş; `--json` ile boru.
- **`updeps show <hedef>`** — tek çalışmanın komutları, çıktısı, commit'i.

Açık hatalar `state.json`'da kalıcı tutulur; o hedef bir daha başarılı/değişiksiz
çalışınca (daemon'dan veya `updeps retry --failed` ile) otomatik temizlenir.
Menü çubuğunda `⚠N` (hata) ve `⧗N` (çalışan + kuyrukta bekleyen iş) rozetleri
ile tıklanabilir hata listesi görünür.

**Gizli bilgi maskeleme:** komut çıktısındaki git remote token'ları, GitHub
PAT'leri, `Authorization` header'ları vb. log'a, journal'a ve bildirime
yazılmadan önce `***` ile maskelenir (`src/redact.js`).

## Dosya konumları

```
~/.config/sqaft-updeps/config.json                    tanım (sen düzenlersin)
~/.local/state/sqaft-updeps/state.json                runtime durumu, açık hatalar
~/.local/state/sqaft-updeps/journal.jsonl             kalıcı işlem günlüğü
~/.local/state/sqaft-updeps/locks/                    hedef repo kilitleri
~/.local/state/sqaft-updeps/logs/updeps.log           ham log (5MB'da rotasyon)
~/Library/LaunchAgents/com.sqaft.updeps.daemon.plist  launchd agent
```

`XDG_CONFIG_HOME` / `XDG_STATE_HOME` tanımlıysa onlara uyar.

---

## Testler

```bash
npm test        # node:test, ek bağımlılık yok
```

---

## Notlar

- Komut `.gitignore`'lu bir dosyayı (`node_modules/` gibi) değiştirirse
  `git status`'ta görünmez — bu istenen davranıştır. Komut hiç izlenen dosya
  değiştirmezse sonuç "güncel" (unchanged) olur.

---

## Lisans

MIT

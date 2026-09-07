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
   şey olmaz — ekstra doğrulamaya gerek yok.)
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
updeps status               # durum, bekleyen push'lar, son çalışmalar
```

---

## Konfigürasyon

Konum: `~/.config/sqaft-updeps/config.json` (`XDG_CONFIG_HOME`'a saygılı).

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
    "push": false
  },
  "repos": [
    {
      "path": "~/workspace/acme/acme-api",
      "name": "@acme/api",         // paket yöneticisindeki bağımlılık adı ({pkg}/{pkgs})
      "branches": ["main"],               // opsiyonel, kaynağa özel
      "packages": [
        {
          "path": "~/workspace/acme/acme-app",
          "name": "acme-app",       // sadece etiket (log/bildirim); verilmezse klasör adı
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
| `{bumps}` | `{pkg}@{sha}` (örn. `@umbrella/api@3b4f1a2`) |
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
| `updeps status` | Daemon durumu, bekleyen push'lar, son çalışmalar, son hatalar |
| `updeps logs [-f] [-n N]` | Logları görüntüler |
| `updeps doctor` | Sistem sağlık kontrolü |
| `updeps start` · `stop` · `restart` | launchd daemon kontrolü |
| `updeps menubar [--install]` | SwiftBar / xbar menü çubuğu eklentisi |

---

## Eşzamanlılık

Tüm sistemde **aynı anda tek iş** çalışır (global seri kuyruk). Bir kaynağa
ardışık push'lar `debounceMs` içinde birleşir. Kuyrukta henüz başlamamış, aynı
hedefe ait bir iş varsa yeni tetikleme ona eklenir (ayrı iş açılmaz) — `{pkgs}`
zaten tüm kaynakları kapsadığı için ikinci çalıştırma no-op olurdu. Çalışmakta
olan bir hedefe yeni olay gelirse iş bittikten sonra tekrar sıraya alınır.

---

## Dosya konumları

```
~/.config/sqaft-updeps/config.json                    tanım (sen düzenlersin)
~/.local/state/sqaft-updeps/state.json                runtime durumu
~/.local/state/sqaft-updeps/locks/                    hedef repo kilitleri
~/.local/state/sqaft-updeps/logs/updeps.log           log (5MB'da rotasyon)
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

- Eski `maxConcurrent` / `globalMaxConcurrent` alanları global seri kuyruk
  nedeniyle işlevsizdir; config'de bulunurlarsa yok sayılır (hata değil, uyarı).
- Komut `.gitignore`'lu bir dosyayı (`node_modules/` gibi) değiştirirse
  `git status`'ta görünmez — bu istenen davranıştır. Komut hiç izlenen dosya
  değiştirmezse sonuç "güncel" (unchanged) olur.

---

## Lisans

MIT

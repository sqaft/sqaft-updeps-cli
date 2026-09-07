# @sqaft/updeps-cli

Git push sonrasında bağımlı repoları otomatik güncelleyen, dil ve paket yöneticisi bağımsız macOS CLI aracı ve arka plan servisi.

---

## 🚀 Özellikler

- **Dil ve Paket Yöneticisi Bağımsız:** Sadece Node.js değil; `npm`, `pnpm`, `yarn`, `cargo`, `pip`, `poetry`, `go mod`, `composer` gibi paket yöneticisi kullanan tüm ekosistemlerle çalışır.
- **Sıfır Maliyet & Event-Driven:** Polling yapmaz; Git reflog dosyalarını `chokidar` (FSEvents) ile izleyerek yalnızca ilgili olaylar (`push`, `fetch`, `commit`, vb.) gerçekleştiğinde tetiklenir.
- **Güvenli & Yapılandırılabilir:** 
  - Çalışma dizini kirli olan (`dirty working tree`) veya `rebase/merge` ortasındaki repolara dokunmaz.
  - Hata durumunda yapılan değişiklikleri otomatik geri alır (`rollback`).
  - Hedef repo başına atomik `mkdir` kilidi ile yarış durumlarını (`race condition`) engeller.
  - **Push Kararı:** Varsayılan olarak `push: false` ile sadece commit atar; istenirse konfigürasyondan `push: true` yapılarak otomatik push aktif edilebilir.
- **Özelleştirilebilir Commit Mesajı:** `{bumps}`, `{pkg}`, `{sha}`, `{branch}` gibi şablon değişkenleriyle commit mesajları yapılandırılabilir.
- **Görünürlük & Teşhis:** macOS masaüstü bildirimleri, SwiftBar/xbar menü çubuğu eklentisi ve sistem sağlık kontrolü (`doctor`).

---

## 📦 Kurulum

```bash
# Depoyu klonlayın ve kök dizinine gidin
npm install

# Global komut olarak bağlayın
npm link
```

Kurulum sonrası hem `updeps` hem de `sqaft-updeps` komutları kullanılabilir.

---

## ⚙️ Yapılandırma (`config.json`)

Konfigürasyon dosyası konumu: `~/.config/sqaft-updeps/config.json`

Örnek bir dosya oluşturmak için:
```bash
updeps init
```

### Örnek Konfigürasyon

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
    },
    {
      "path": "~/workspace/rust-core",
      "packages": [
        {
          "path": "~/workspace/rust-app",
          "commands": [
            "cargo update -p {pkg}",
            "cargo test"
          ],
          "commitMessage": "deps(cargo): bump {bumps}",
          "push": true
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

### Şablon Değişkenleri

`commands` ve `commitMessage` alanlarında aşağıdaki şablon değişkenleri kullanılabilir:

- `{pkg}` — Tetikleyen kaynak paketin/reponun adı
- `{pkgs}` — Güncellenen paket(ler)in adı
- `{sha}` — Tetikleyen commit'in 7 haneli kısa SHA'sı
- `{bumps}` — Özet etiketi (örn. `http@3b4f1a2`)
- `{sourcePath}` — Kaynak reponun tam yolu
- `{targetPath}` / `{repoPath}` — Hedef reponun tam yolu
- `{sourceBranch}` — Kaynak reponun tetikleyen branch'i
- `{targetBranch}` / `{branch}` — Hedef reponun aktif branch'i

---

## 🛠 CLI Komutları

| Komut | Açıklama |
|---|---|
| `updeps init` | Örnek konfigürasyon dosyası (`config.json`) oluşturur. |
| `updeps list` | Kayıtlı kaynak repoları ve hedef paket ilişkilerini listeler. |
| `updeps graph` | Bağımlılık ilişkilerini ASCII ağacı olarak gösterir ve cycle analizi yapar. |
| `updeps add <kaynak> --target <hedef>` | Konfigürasyona yeni bir ilişki ekler. |
| `updeps remove <kaynak> [hedef]` | Bir ilişkiyi veya kaynak repoyu siler. |
| `updeps run [kaynak] [--dry-run]` | Bağımlılık güncellemesini manuel olarak çalıştırır (`--dry-run` commit atmadan dener). |
| `updeps status` | Daemon durumu, bekleyen push'lar ve son çalıştırma özetlerini gösterir. |
| `updeps doctor` | Sistem sağlık kontrolü yapar (yollar, git reflog ayarları, komutların PATH'teki varlığı). |
| `updeps logs [--follow]` | Çalışma loglarını görüntüler. |
| `updeps start` | launchd arka plan servisini (daemon) başlatır. |
| `updeps stop` | launchd servisini durdurur. |
| `updeps restart` | launchd servisini yeniden başlatır. |
| `updeps menubar [--install]` | SwiftBar / xbar menü çubuğu çıktısı üretir veya eklentiyi kurar. |

---

## 🧪 Testler

Testleri çalıştırmak için:

```bash
npm test
```

Testler Node.js'in yerleşik `node:test` test koşucusu ile çalıştırılır ve ek bir test bağımlılığı gerektirmez.

---

## 📄 Lisans

MIT
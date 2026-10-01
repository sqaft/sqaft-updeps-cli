# @sqaft/updeps-cli

**Durum:** Geliştirme aşamasında  
**Tür:** Bağımsız kütüphane / ürün

Bir paket push edildiğinde onu bağımlılık olarak kullanan repoları otomatik güncelleyen, dil ve paket yöneticisinden bağımsız macOS CLI'ı ve arka plan servisi (launchd daemon). Ayrıntılar: `README.md`, `updeps --help`.

## Komutlar

- `npm test` — `node --test --test-force-exit 'test/*.test.js'`
- `npm start` — daemon'u ön planda çalıştırır

## Dikkat

- Bu araç şu an makinede **canlı olarak** çalışıyor (global kurulu `updeps` ve launchd daemon). Gerçek repolarda komut çalıştırır. Geliştirirken kurulu daemon'u ve gerçek konfigürasyonu bozacak bir şey yapma (`reset`, `remove`, `stop`, `run`). Test için `--dry-run` ve test fixture'larını kullan.
- CLI komutları veya seçenekleri değişirse `--help` çıktısını ve `README.md` dosyasını da güncelle.
- Menubar eklentisi (SwiftBar/xbar) CLI çıktısına bağlıysa, çıktı formatı değişikliklerinde onu da kontrol et.

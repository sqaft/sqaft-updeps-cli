# LEARNINGS

## 2026-10-01 — Commit birleştirmede `reset --soft` + `commit` yerine `commit-tree` + `update-ref`
`git reset --soft HEAD~n` ardından `git commit -- <dosyalar>` (`--only` semantiği) dosyaları working tree'deki **güncel** içerikleriyle commit'ler; önceki updeps commit'inin dosyasında kullanıcının sonradan yaptığı kirli değişiklik varsa onu da commit'e sokar. Bunun yerine normal update commit'i atılıp `git commit-tree <aynı tree> -p <base>` ile tek commit üretilir ve `git update-ref <ref> <yeni> <eski>` ile dalın ucu taşınır: index/working tree'ye dokunulmaz, ağaç birebir aynı kalır, ref güncellemesi CAS olduğu için eşzamanlı bir commit'te sessizce vazgeçer.

## 2026-10-01 — `updeps push` bir push'un işlendiğini `lastProcessedSha` ile anlar
Daemon, bir kaynağın push'unun tüm hedefleri bittiğinde `state.repos[<kaynak>].lastProcessedSha` değerini `origin/<branch>` ucuna eşitler (tüm hedefler `skipped` olsa da). Kuyruk boş + `activeRun` yok bilgisi tek başına yetmez: reflog olayı ve debounce penceresi sırasında daemon boş görünür.

## 2026-10-17 — Komut öncesi/sonrası `git status` farkı, değişikliği kimin yaptığını söylemez
Fark, komutun çalıştığı pencerede değişen her yolu içerir; aynı anda bir editörün, build watcher'ın ya da başka bir aracın oluşturduğu takipsiz dosyalar ve düzenlediği temiz takipli dosyalar da buna girer. Farkın tamamını commit'lemek başkasının işini update commit'ine sokar, hata durumunda farkı `git checkout` ile geri almak da o işi siler. Bu yüzden commit ve geri alma kapsamı komutun üretmesi beklenen dosyalarla (`commitPaths`: kilit dosyaları, manifestler) sınırlanır, gerisi yalnızca raporlanır.

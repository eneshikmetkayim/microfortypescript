# GitHub deposu ve doğrulama

Depo: <https://github.com/eneshikmetkayim/microfortypescript> (public)

Varsayılan branch `main`; `v0.1.0` (SIP çekirdeği + CLI + ilk panel),
`v0.2.0` (operatör konsolu, kurulum sihirbazı, gelen havuzu) ve `v0.3.0`
(gerçek SIP INVITE smoke testi, korumalı `main`) etiketleri yayınlanmıştır.

## Geliştirme akışı

```bash
npm ci
npm run ci                     # typecheck + testler + audit

git switch -c konu-basligi
# değişiklikler…
npm run ci
git commit -m "feat: …"
git push -u origin konu-basligi
gh pr create --fill           # CI yeşil olunca merge
```

`main` korumalıdır: doğrudan push (adminler dahil) reddedilir, değişiklikler
PR ile birleştirilir. Etiketli sürüm:

```bash
git tag -a v0.3.0 -m "…"
git push origin v0.3.0
```

## CI ne yapıyor?

`.github/workflows/ci.yml` her push ve pull request'te:

| İş | Ne doğrular |
| --- | --- |
| `test` | Ubuntu + Windows / Node 24: `npm ci`, `tsc --noEmit`, tüm testler, JUnit artifact, CLI smoke (`version`, `init`, `config`) |
| `conformance` | `npm run audit`: matris kanıtı + test paketi; `audit-report.md/json` artifact ve iş özeti |
| `web` | Paneli başlatır, `/api/status` JSON'unu ve ana sayfa HTML'ini doğrular; ardından `npm run smoke` gerçek UDP INVITE ile cevapla/reddet akışını ve geçmiş kayıtlarını sınar |

Yeşil `conformance` işi "uyarlanan her modülün kaynağı ve testi var, testler
geçiyor" anlamına gelir; medya/arayüz gibi taşınamayan başlıklar matriste
`not-portable` olarak açıkça işaretlidir.

## Depo ayarları

- **Branches → default:** `main`.
- **Actions → General:** "Allow all actions" yeterli; ek secret gerekmez.
- **Artifacts:** `conformance-audit` (rapor) ve `test-results-*` (JUnit).
- Branch protection açıktır: `main`e doğrudan push, force-push ve silme kapalı
  (adminler dahil). Zorunlu kontroller `test (ubuntu-latest, node 24.x)`,
  `test (windows-latest, node 24.x)`, `conformance audit` ve
  `web panel smoke`; dördü yeşil olmadan PR birleştirilemez.

## Yerelde aynı kontroller

```bash
npm ci
npm run typecheck
npm test
npm run smoke
npm run audit
node src/cli.ts serve --ini microsip.ini   # paneli elle dene
```

## Sırlar

Depoda sır yoktur. Gerçek kimlik bilgileri içeren `microsip.ini`, `.env`,
`data/`, `tmp/` ve panel çıktıları `.gitignore` ile dışlanır; yalnızca
`microsip.example.ini` örneği izlenir. Üretim kimlik bilgilerini ayrı, izlenmeyen
bir dosyada tutun ve CI'ya eklemeyin.

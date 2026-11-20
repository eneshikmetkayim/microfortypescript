# GitHub deposu ve doğrulama

Hedef depo: `git@github.com:eneshikmetkayim/microfortypescript.git`

## İlk push

Yerel repo hazır ve adım adım commit'lenmiştir. Depoyu bağlayıp göndermek için:

```bash
git remote add origin git@github.com:eneshikmetkayim/microfortypescript.git
git branch -M main
git push -u origin main
```

SSH anahtarı yoksa:

```bash
gh auth login
gh repo view eneshikmetkayim/microfortypescript
# gerekirse:
gh repo create eneshikmetkayim/microfortypescript --private --source=. --remote=origin --push
```

Bu adımlar bu çalışma sırasında **çalıştırılmadı**; push kullanıcıya aittir.

## CI ne yapıyor?

`.github/workflows/ci.yml` her push ve pull request'te:

| İş | Ne doğrular |
| --- | --- |
| `test` | Ubuntu + Windows / Node 24: `npm ci`, `tsc --noEmit`, tüm testler, JUnit artifact, CLI smoke (`version`, `init`, `config`) |
| `conformance` | `npm run audit`: matris kanıtı + test paketi; `audit-report.md/json` artifact ve iş özeti |
| `web` | Paneli başlatır, `/api/status` JSON'unu ve ana sayfa HTML'ini doğrular |

Yeşil `conformance` işi "port edilen her modülün kaynağı ve testi var, testler
geçiyor" anlamına gelir; medya/arayüz gibi taşınamayan başlıklar matriste
`not-portable` olarak açıkça işaretlidir.

## Önerilen depo ayarları

- **Branch protection** (`main`): `test (ubuntu-latest, node 24.x)`,
  `test (windows-latest, node 24.x)`, `conformance audit`, `web panel smoke`
  zorunlu statüler.
- **Actions → General**: "Allow all actions" yeterli; ek secret gerekmez.
- **Artifacts**: `conformance-audit` (rapor) ve `test-results-*` (JUnit).

## Yerelde aynı kontroller

```bash
npm ci
npm run typecheck
npm test
npm run audit
node src/cli.ts serve --ini microsip.ini   # paneli elle dene
```

## Sırlar

Depoda sır yoktur. `microsip.ini` gerçek parola içeriyorsa commit'lenmemelidir;
`.gitignore` yalnızca çalışma zamanı çıktılarını (`data/`, `audit-report.*`,
`test-results.xml`) dışlar. Üretim kimlik bilgileri için ayrı, izlenmeyen bir
dosya kullanın ve CI'ya eklemeyin.

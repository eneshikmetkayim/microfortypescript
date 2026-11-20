# Birebir uygunluk (parity) yöntemi

Bu belge, portun MicroSIP 3.23.5 ile **neyi aynı**, neyi bilinçli olarak farklı
yaptığını kaydeder. Her iddia bir test dosyasına veya kaynak satırına bağlıdır.

## 1. Kanıt zinciri

| Katman | MicroSIP kaynağı | Port | Test |
| --- | --- | --- | --- |
| SIP mesajı | pjlib/pjsip parser | `src/sip/message.ts` | `tests/message.test.ts` |
| SIP URI | `MSIP::ParseSIPURI`, `SIPURI` | `src/sip/uri.ts` | `tests/uri.test.ts` |
| urlencode | `global.cpp:945` | `urlencode()` | `tests/uri.test.ts` |
| MD5 | `lib/MSIP.cpp:32` | `src/sip/md5.ts` | `tests/md5.test.ts` |
| Digest | pjsip auth | `src/sip/digest.ts` | `tests/digest.test.ts` |
| REGISTER | pjsua hesap kaydı | `src/sip/registration.ts` | `tests/registration.test.ts` |
| Transaction | pjsip transaction | `src/sip/transaction.ts` | `tests/transaction.test.ts` |
| Çağrı | `mainDlg.cpp onCallState` | `src/sip/call.ts` | `tests/call.test.ts` |
| SDP | pjmedia | `src/sip/sdp.ts` | `tests/sdp.test.ts` |
| Ayarlar | `settings.cpp` | `src/core/settings.ts` | `tests/settings.test.ts` |
| URLMask | `global.cpp:1245` | `src/core/urlmask.ts` | `tests/urlmask.test.ts` |
| Numara | `global.cpp FormatNumber` | `src/core/dialing.ts` | `tests/dialing.test.ts` |
| Komutlar | `mainDlg.cpp:4410/4438` | `src/core/commands.ts` | `tests/ini.test.ts` |
| Çağrı kaydı | `Data/Database.cpp` | `src/core/calllog.ts` | `tests/calllog.test.ts` |
| Kişiler | `Data/ContactsRepository.cpp` | `src/core/contacts.ts` | `tests/contacts.test.ts` |
| Uygulama | `CmainDlg` | `src/core/softphone.ts` | `tests/softphone.test.ts` |

Testler gerçek SIP baytları üretir ve loopback taşıma üzerinden karşı tarafa
ulaştırır (`tests/helpers/uas.ts`). Mock'lanan şey ağ değil, ağın *karşı ucu*.

## 2. Birebir korunan davranışlar

- **Varsayılan codec sırası** `define.h:61`: `PCMA/8000/1 PCMU/8000/1`.
- **`urlencode()`** yalnızca alfanümerik + `~ ! * ' ( )` karakterlerini bırakır,
  diğerlerini **küçük harfli** `%xx` yapar (`.`, `-`, `@` dahil encode edilir).
- **`{callerid}` önceliği**: `URLMask` önce çağrı verisindeki caller-ID'yi
  yazar; `CString::Replace` tüm geçişleri anında değiştirdiği için sonraki
  URI adı/numarası yazımı etkisiz kalır. Test bunu kilitler.
- **`{md5_password}`** UTF-8 parolanın küçük harfli MD5'idir.
- **Dial plan**: `x` tek karakter, `.` önceki öğenin sıfır veya daha fazlası,
  `[2-9]` küme/aralık, `<a:b>` yakala-değiştir, `<:b>` ekle, `|` alternatif,
  dış parantezler kırpılır; hiçbir kalıba uymayan numara **engellenir**.
- **Dialing prefix** yalnızca PSTN görünümlü (≥4 karakter) numaralara uygulanır
  ve baştaki `+` atılır. Bu yüzden `1002` gibi 4 haneli dahililer de prefix alır
  — MicroSIP'te de böyledir.
- **`GetSIPURI`**: `sip:` yoksa eklenir, `@` yoksa alan adı ilk `;`/`?`
  karakterinin **önüne** eklenir, sonuç `<...>` içine alınır.
- **`call_log`**: aynı sütunlar, `callId` tekil indeksi, 1000 satır tavanı ve
  tip kodları `Domain/Call.h:22` (0 giden, 1 gelen, 2 cevapsız, 3 başka yerde).
- **cmd\* kancaları**: şablon `URLMask` ile genişletilir, `RunCmdCOM` parametre
  olarak numarayı ekler; `WM_COPYDATA` zarfı `dwData=1|2` + NUL'lu metin.
- **Transaction zamanlayıcıları**: T1=500 ms, T2=4 s, B/F=32 s; güvenilir
  taşımada yeniden gönderim yok; 2xx dışı INVITE yanıtına ACK aynı branch ile.
- **Çağrı durumları**: calling → early (180/183) → connecting → confirmed →
  disconnected; yerel iptal CANCEL, karşıdan gelen BYE 200 ile yanıtlanır.

## 3. Bilinçli sapmalar (ve nedenleri)

| Konu | MicroSIP | Port | Neden |
| --- | --- | --- | --- |
| Dial plan değiştirme | `CString::Right()` ile yeniden kurma (`global.cpp:170`) | Yakalama aralıkları `d` bayrağıyla yerinde birleştirilir | Upstream kodda `szPrev - ... - 1` hesabı belgelenen örneklerle çelişiyor; port belgelenen davranışı (`<8:1555>xxxxxxx` → `15551234567`) uygular ve test eder |
| 487 sonrası sebep | pjsua durum metni | yerel iptalde `Call cancelled` korunur | Kullanıcıya MicroSIP'in gösterdiği sebep gösterilir |
| DNS | pjsua SRV/NAPTR | A kaydı / doğrudan host | SRV henüz yok (matriste `pending`) |
| Medya | pjmedia aygıtları | `SdpOnlyMediaSession` (sinyalizasyon) | Node'da yerel ses aygıtı yok; WebRTC planlanıyor |
| Arayüz | MFC diyalogları | web paneli + CLI | Windows'a bağımlılığı kaldırmak için |

## 4. Tam audit prosedürü

```bash
npm ci
npm run typecheck
npm test
npm run audit
```

Audit şunları doğrular:

1. `docs/port-matrix.json` içindeki her `ported`/`adapted` girdinin kaynak
   dosyası var mı?
2. Her `ported` girdinin en az bir test dosyası ve `test()` çağrısı var mı?
3. Tüm test paketi geçiyor mu (TAP çıktısından `# pass`, `# fail`)?
4. Rapor `audit-report.md` + `audit-report.json` olarak yazılır; CI bunları
   artifact ve iş özeti olarak yayınlar.

Gerçek bir PBX'e karşı doğrulama (Faz 0'da santral seçildikten sonra)
`node src/cli.ts dial` ve `serve` paneli ile yapılır; o aşamada kayıt, gelen
çağrı, bekleme, DTMF ve transfer elle doğrulanmalıdır. Bu adım henüz
çalıştırılmadı — testler santralsiz doğrulanabilen katmanı kapsar.

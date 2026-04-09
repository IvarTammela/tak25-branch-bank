# TAK25 Branch Bank API

Panga harukontori API hajutatud pangandussüsteemi jaoks. Toetab kasutajate registreerimist, kontode haldust, pangasiseseid ja pankadevahelisi ülekandeid ning keskpanga integratsiooni.

## Live URL

- **API:** http://46.62.166.124:8081
- **Swagger UI:** http://46.62.166.124:8081/docs
- **Web UI:** http://46.62.166.124:8081
- **Bank ID:** AKB001 (prefiks AKB)

Hetzner VPS, Node 22, systemd teenus.

## Kasutatud tehnoloogiad

| Tehnoloogia | Otstarve |
|---|---|
| Node.js 22 | Runtime |
| TypeScript | Tüübitud kood |
| Fastify | HTTP raamistik |
| SQLite (better-sqlite3) | Andmebaas |
| JOSE | ES256 JWT allkirjastamine ja verifitseerimine |
| Zod | Sisendi valideerimine |
| @fastify/swagger + swagger-ui | API dokumentatsioon |
| Docker Compose | Konteineripõhine deploy |

## Mikroteenuste arhitektuur

Süsteem koosneb kolmest iseseisvast komponendist:

```
┌─────────────────────────────────────────────────────┐
│                    Kliendid                          │
│         (Web UI, Swagger UI, curl, teised pangad)    │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────┐  ┌──────────────────────────┐
│   branch-api         │  │   bank-worker             │
│   (HTTP server)      │  │   (taustaprotsess)        │
│                      │  │                           │
│ - /api/v1/users      │  │ - keskpanga registreering  │
│ - /api/v1/accounts   │  │ - heartbeat (10 min)      │
│ - /api/v1/transfers  │  │ - kataloogi sync (5 min)  │
│ - /api/v1/sync       │  │ - kursside sync (5 min)   │
│ - /transfers/receive │  │ - pending retry (15 sek)  │
│ - /docs (Swagger)    │  │ - timeout refund (4h)     │
└──────────┬───────────┘  └──────────┬────────────────┘
           │                         │
           ▼                         ▼
┌─────────────────────────────────────────────────────┐
│                  SQLite andmebaas                     │
│  (WAL mode, busy_timeout, transaktsioonid)           │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│              Keskpank (väline API)                    │
│  POST /banks, GET /banks, POST /heartbeat            │
│  GET /exchange-rates                                 │
└─────────────────────────────────────────────────────┘
```

**Produkstioonis** (Hetzner) jooksevad API ja worker samas protsessis (`npm start`), kuna jagavad sama SQLite faili.

**Docker Compose'iga** saab käivitada eraldi teenustena:
- `branch-api` - HTTP API
- `bank-worker` - taustaprotsess

Iga teenus on iseseisvalt deployeritav ja skaleeritav.

## Andmebaasi skeem

```sql
-- Kasutajad
users (id TEXT PK, full_name TEXT, email TEXT UNIQUE, api_key_hash TEXT, created_at TEXT)

-- Kontod (saldo sentides, vältimaks ujukomaaritmeetika vigu)
accounts (account_number TEXT PK, owner_id TEXT FK->users, currency TEXT, balance_minor INT, created_at TEXT)

-- Ülekanded (pangasisesed ja pankadevahelised)
transfers (transfer_id TEXT PK, direction TEXT, status TEXT, source_account TEXT,
           destination_account TEXT, amount_minor INT, amount_currency TEXT,
           source_currency TEXT, destination_currency TEXT, converted_amount_minor INT,
           exchange_rate TEXT, rate_captured_at TEXT, error_message TEXT,
           initiated_by_user_id TEXT, pending_since TEXT, next_retry_at TEXT,
           retry_count INT, source_bank_id TEXT, destination_bank_id TEXT,
           created_at TEXT, updated_at TEXT, locked_amount_minor INT)

-- Panga identiteet (1 rida)
bank_identity (id INT PK, bank_id TEXT, bank_prefix TEXT, public_key TEXT,
               address TEXT, name TEXT, registered_at TEXT, expires_at TEXT)

-- Keskpanga kataloog (vahemälu)
bank_directory (bank_id TEXT PK, name TEXT, address TEXT, public_key TEXT,
                last_heartbeat TEXT, status TEXT)

-- Valuutakursid (vahemälu)
exchange_rates (currency TEXT PK, rate TEXT, captured_at TEXT)

-- Seaded (sync ajatemplid)
settings (key TEXT PK, value TEXT)
```

Kõik saldo muutused tehakse SQLite transaktsioonides. WAL mode + busy_timeout tagavad samaaegse ligipääsu.

## API endpointid

### Kasutajahaldus
| Meetod | Path | Auth | Kirjeldus |
|---|---|---|---|
| POST | /api/v1/users | - | Registreeri kasutaja |
| POST | /api/v1/auth/tokens | - | Hangi Bearer token |
| GET | /api/v1/users/{userId} | Bearer | Kasutaja profiil |

### Kontohaldus
| Meetod | Path | Auth | Kirjeldus |
|---|---|---|---|
| POST | /api/v1/users/{userId}/accounts | Bearer | Loo konto |
| GET | /api/v1/users/{userId}/accounts | Bearer | Kasutaja kontod |
| GET | /api/v1/accounts/{accountNumber} | - | Konto otsing |
| GET | /api/v1/accounts | - | Kõik kontod |
| POST | /api/v1/accounts/{accountNumber}/deposit | Bearer | Raha lisamine |

### Ülekanded
| Meetod | Path | Auth | Kirjeldus |
|---|---|---|---|
| POST | /api/v1/transfers | Bearer | Alusta ülekannet |
| GET | /api/v1/transfers/{transferId} | Bearer | Ülekande staatus |
| GET | /api/v1/users/{userId}/transfers | Bearer | Ülekannete ajalugu |
| POST | /api/v1/transfers/receive | JWT | Pankadevahelise ülekande vastuvõtt |

### Admin
| Meetod | Path | Auth | Kirjeldus |
|---|---|---|---|
| POST | /api/v1/sync | - | Sünkroniseeri keskpangaga |
| GET | /api/v1/banks | - | Registreeritud pangad |
| GET | /health | - | Terviskontroll |

## Bearer autentimine

1. Registreeri kasutaja:
```bash
curl -i -X POST http://46.62.166.124:8081/api/v1/users \
  -H 'content-type: application/json' \
  -d '{"fullName":"Jane Doe","email":"jane@example.com"}'
```
Vastuse päisest `x-api-key` kopeeri API võti.

2. Hangi token:
```bash
curl -X POST http://46.62.166.124:8081/api/v1/auth/tokens \
  -H 'content-type: application/json' \
  -d '{"userId":"user-...","apiKey":"..."}'
```

3. Kasuta tokenit:
```bash
curl -H "Authorization: Bearer <accessToken>" http://46.62.166.124:8081/api/v1/users/<userId>/accounts
```

## Näidispäringud

Konto loomine:
```bash
curl -X POST http://46.62.166.124:8081/api/v1/users/$USER_ID/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"currency":"EUR"}'
```

Raha lisamine:
```bash
curl -X POST http://46.62.166.124:8081/api/v1/accounts/AKB12345/deposit \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"amount":"100.00"}'
```

Ülekanne (pangasisene):
```bash
curl -X POST http://46.62.166.124:8081/api/v1/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "transferId":"550e8400-e29b-41d4-a716-446655440000",
    "sourceAccount":"AKB12345",
    "destinationAccount":"AKB67890",
    "amount":"25.00"
  }'
```

Konto otsing (autentimata):
```bash
curl http://46.62.166.124:8081/api/v1/accounts/AKB12345
```

## Keskpanga integratsioon

Worker suhtleb keskpangaga (`https://test.diarainfra.com/central-bank/api/v1`):

| Endpoint | Sagedus | Otstarve |
|---|---|---|
| POST /banks | Käivitusel | Panga registreerimine |
| POST /banks/{bankId}/heartbeat | 10 min | Registreerimise säilitamine (30 min timeout) |
| GET /banks | 5 min | Pankade kataloogi sünkroniseerimine |
| GET /exchange-rates | 5 min | Valuutakursside uuendamine |

Pankadevahelistes ülekannetes allkirjastatakse JWT ES256 algoritmiga. Vastuvõttev pank verifitseerib signatuuri keskpanga kataloogist saadud avaliku võtme abil.

## Ülekannete töötlus

**Pangasisene ülekanne:**
- Kohe transaktsioonis debiteerimine + krediteerimine
- Valuutakonversioon keskpanga kursside alusel

**Pankadevaheline ülekanne:**
1. Lähtekontolt raha lukustatakse kohe
2. Sihtpanka üritatakse kohe JWT-ga kutsuda
3. Ajutise vea korral jääb staatus `pending`
4. Worker teeb exponential backoff retry (1min, 2min, 4min, ... kuni 1h)
5. 4 tunni järel märgitakse `failed_timeout` ja raha tagastatakse

**Idempotentsus:** Duplikaat `transferId` tagastab 409.

## Käivitamine

```bash
npm install
cp .env.example .env
# Muuda .env failis BANK_ADDRESS ja CENTRAL_BANK_BASE_URL
npm start
```

Eraldi workeriga (Docker Compose):
```bash
docker compose up --build
```

## Testimine

```bash
npm test
```

Kaetud stsenaariumid:
- Kasutaja registreerimine ja API võtme väljastus
- Bearer tokeni loomine ja verifitseerimine
- Pangasisene ülekanne saldo muutustega
- Pankadevahelise ES256 JWT vastuvõtmine ja verifitseerimine

Täielik integratsioonitesti tulemused (28 endpointi): kõik läbivad.

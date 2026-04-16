# TAK25 Branch Bank API

Panga harukontori API hajutatud pangandussüsteemi jaoks. Toetab kasutajate registreerimist, kontode haldust, pangasiseseid ja pankadevahelisi ülekandeid ning keskpanga integratsiooni.

## Live URL

- **API:** http://46.62.166.124:8081
- **Swagger UI:** http://46.62.166.124:8081/docs
- **Web UI:** http://46.62.166.124:8081
- **Bank ID:** BRA001 (prefiks BRA)

## Kasutatud tehnoloogiad

| Tehnoloogia | Otstarve |
|---|---|
| Node.js 22 | Runtime |
| TypeScript | Tüübitud kood |
| Fastify | HTTP raamistik |
| SQLite (better-sqlite3) | Andmebaas (iga teenus oma) |
| JOSE | ES256 JWT allkirjastamine ja verifitseerimine |
| Zod | Sisendi valideerimine |
| @fastify/swagger + swagger-ui | API dokumentatsioon |

## Mikroteenuste arhitektuur

Süsteem koosneb 5 iseseisvast teenusest, igaühel oma andmebaas ja vastutusala:

```
                    ┌─────────────────────┐
                    │     Kliendid        │
                    │ (Web UI, Swagger,   │
                    │  curl, teised pangad)│
                    └────────┬────────────┘
                             │
                    ┌────────▼────────────┐
                    │   API Gateway       │
                    │   port 8081         │
                    │   (marsruutimine,   │
                    │    UI, Swagger)     │
                    └──┬───┬───┬───┬─────┘
                       │   │   │   │
          ┌────────────┘   │   │   └────────────┐
          ▼                ▼   ▼                ▼
 ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐
 │ User Service│  │Account Service│  │ Transfer Service  │
 │ port 8082   │  │ port 8083    │  │ port 8084         │
 │             │  │              │  │                   │
 │ - register  │  │ - kontod     │  │ - ülekanded       │
 │ - auth      │  │ - saldod     │  │ - inter-bank JWT  │
 │ - profiilid │  │ - deposit    │  │ - retry worker    │
 └─────────────┘  └──────────────┘  └───────────────────┘
        │                │                    │
        ▼                ▼                    ▼
  user-service.db  account-service.db  transfer-service.db
                                              │
                    ┌─────────────────────────┘
                    ▼
          ┌──────────────────────┐
          │Central Bank Service  │
          │ port 8085            │
          │                     │
          │ - registreerimine   │
          │ - heartbeat         │
          │ - kataloogi sync    │
          │ - kursside sync     │
          └──────────────────────┘
                    │
                    ▼
           central-bank-service.db
```

### Teenuste kirjeldus

**API Gateway (port 8081)** - Marsruudib välised päringud õigesse teenusesse. Serveerib Web UI-d ja Swagger dokumentatsiooni. Ei oma andmeid.

**User Service (port 8082)** - Kasutajate registreerimine, API võtmete haldus, Bearer tokenite väljastamine. Omab `users` tabelit.

**Account Service (port 8083)** - Kontode loomine, saldode haldus, deposiidid, konto otsingud. Omab `accounts` tabelit. Suhtleb User Service'iga omanike nimede jaoks.

**Transfer Service (port 8084)** - Pangasisesed ja pankadevahelised ülekanded, ES256 JWT vastuvõtt, retry worker pending ülekannetele. Omab `transfers` tabelit. Suhtleb Account Service'iga saldode muutmiseks.

**Central Bank Service (port 8085)** - Keskpanga registreerimine ja heartbeat, pankade kataloogi sünkroniseerimine, valuutakursside uuendamine. Omab `bank_identity`, `bank_directory`, `exchange_rates` tabeleid.

### Teenustevaheline suhtlus

Teenused suhtlevad REST API kaudu üle HTTP:
- Account Service -> User Service: kasutaja nime päring (`/internal/users/:id`)
- Transfer Service -> Account Service: saldo kontroll ja muutmine (`/internal/accounts/:nr/adjust`)
- Transfer Service -> Central Bank Service: panga identiteet, kataloog, kursid (`/internal/*`)
- Account Service -> Central Bank Service: panga prefiks (`/internal/identity`)

## Andmebaasi skeem

Iga teenus omab oma SQLite andmebaasi:

**user-service.db:**
```sql
users (id TEXT PK, full_name TEXT, email TEXT UNIQUE, api_key_hash TEXT, created_at TEXT)
```

**account-service.db:**
```sql
accounts (account_number TEXT PK, owner_id TEXT, currency TEXT, balance_minor INT, created_at TEXT)
```

**transfer-service.db:**
```sql
transfers (transfer_id TEXT PK, direction TEXT, status TEXT, source_account TEXT,
           destination_account TEXT, amount_minor INT, amount_currency TEXT,
           converted_amount_minor INT, exchange_rate TEXT, error_message TEXT,
           initiated_by_user_id TEXT, pending_since TEXT, next_retry_at TEXT,
           retry_count INT, source_bank_id TEXT, destination_bank_id TEXT,
           created_at TEXT, updated_at TEXT, locked_amount_minor INT)
```

**central-bank-service.db:**
```sql
bank_identity (id INT PK, bank_id TEXT, bank_prefix TEXT, public_key TEXT, address TEXT, name TEXT)
bank_directory (bank_id TEXT PK, name TEXT, address TEXT, public_key TEXT, last_heartbeat TEXT, status TEXT)
exchange_rates (currency TEXT PK, rate TEXT, captured_at TEXT)
```

Kõik saldo muutused tehakse transaktsioonides. WAL mode + busy_timeout tagavad samaaegse ligipääsu.

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

## Käivitamine

### Kõik teenused korraga
```bash
npm install
cp .env.example .env
npm start
```

### Üksikud teenused
```bash
npm run start:central-bank-service
npm run start:user-service
npm run start:account-service
npm run start:transfer-service
npm run start:gateway
```

### Monoliitne režiim (arenduseks)
```bash
npm run start:monolith
```

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
curl -H "Authorization: Bearer <accessToken>" \
  http://46.62.166.124:8081/api/v1/users/<userId>/accounts
```

## Näidispäringud

Konto loomine:
```bash
curl -X POST http://46.62.166.124:8081/api/v1/users/$USER_ID/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"currency":"EUR"}'
```

Ülekanne:
```bash
curl -X POST http://46.62.166.124:8081/api/v1/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "transferId":"550e8400-e29b-41d4-a716-446655440000",
    "sourceAccount":"BRA12345",
    "destinationAccount":"TAK67890",
    "amount":"25.00"
  }'
```

## Keskpanga integratsioon

Central Bank Service suhtleb keskpangaga (`https://test.diarainfra.com/central-bank/api/v1`):

| Endpoint | Sagedus | Otstarve |
|---|---|---|
| POST /banks | Käivitusel | Panga registreerimine |
| POST /banks/{bankId}/heartbeat | 10 min | Registreerimise säilitamine |
| GET /banks | 5 min | Pankade kataloogi sünkroniseerimine |
| GET /exchange-rates | 5 min | Valuutakursside uuendamine |

## Ülekannete töötlus

**Pangasisene ülekanne:**
- Transfer Service kutsub Account Service't saldo debiteerimiseks ja krediteerimiseks
- Valuutakonversioon keskpanga kursside alusel

**Pankadevaheline ülekanne:**
1. Transfer Service debiteerib lähtekonto Account Service kaudu
2. Allkirjastab JWT ES256-ga ja saadab sihtpangale
3. Ajutise vea korral jääb staatus `pending`
4. Retry worker teeb exponential backoff (1min -> 2min -> 4min -> ... -> 1h)
5. 4h järel `failed_timeout` ja Account Service kaudu refund

## Testimine

```bash
npm test
```

### Testide tulemused (29 endpointi)

| # | Test | Tulemus |
|---|---|---|
| 1 | GET /health | **OK** |
| 2 | POST /sync | **OK** 3 panka |
| 3 | GET /banks | **OK** |
| 4 | POST /users (register) | **201** |
| 5 | POST /users (duplicate) | **409** |
| 6 | POST /auth/tokens | **200** |
| 7 | POST /auth/tokens (bad key) | **401** |
| 8 | GET /users/{id} | **200** |
| 9 | GET /users/{id} (no auth) | **401** |
| 10 | POST accounts (EUR) | **201** |
| 11 | POST accounts (USD) | **201** |
| 12 | POST accounts (bad currency) | **400** |
| 13 | GET user accounts | **200** |
| 14 | GET account lookup | **200** |
| 15 | GET account (bad format) | **400** |
| 16 | GET account (not found) | **404** |
| 17 | GET all accounts | **200** |
| 18 | POST deposit | **200** |
| 19 | POST deposit (zero) | **400** |
| 20 | POST transfer EUR->USD | **201** completed, kurss 1.08 |
| 21 | POST transfer (duplicate) | **409** |
| 22 | POST transfer (insufficient) | **422** |
| 23 | POST transfer (self) | **400** |
| 24 | GET transfer status | **200** |
| 25 | GET transfer (not found) | **404** |
| 26 | GET transfer history | **200** |
| 27 | POST /transfers/receive (bad JWT) | **401** |
| 28 | GET / (Web UI) | **200** |
| 29 | GET /docs (Swagger) | **200** |

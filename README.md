# TAK25 Branch Bank API

Täielik harukontori API, mis realiseerib kasutajate registreerimise, kontode loomise, ülekanded, pankadevahelise JWT-põhise suhtluse ja keskpanga integratsiooni.

## Kasutatud tehnoloogiad

- Node.js 22
- TypeScript
- Fastify
- SQLite (`better-sqlite3`)
- JOSE (`ES256` JWT allkirjastamine ja verifitseerimine)
- Docker Compose API + worker protsesside käivitamiseks

## Mikroteenuste arhitektuur

Lahendus on jagatud kaheks iseseisvalt käivitatavaks teenuseks:

1. `branch-api`
   Avalik HTTP API kasutajatele ja teistele pankadele.
2. `bank-worker`
   Taustaprotsess, mis:
   - registreerib panga keskpangas,
   - saadab heartbeat'e,
   - sünkroniseerib pankade kataloogi,
   - sünkroniseerib valuutakursse,
   - töötleb pending pankadevahelisi ülekandeid.

Teenused on eraldi deployeritavad ja neid saab skaleerida sõltumatult. API teenus teenindab päringuid, worker haldab taustal integratsiooni- ja retry-loogikat.

## Andmebaasi skeem

Peamised tabelid:

- `users`
  Kasutaja põhiandmed ja API võtme räsi.
- `accounts`
  Konto number, omanik, valuuta, saldo sentides.
- `transfers`
  Pangasisesed ja pankadevahelised ülekanded, staatus, retry väljad, kursid ja audit info.
- `bank_identity`
  Kohaliku panga identiteet, avalik võti, keskpanga `bankId` ja konto prefiks.
- `bank_directory`
  Keskpangast sünkroniseeritud pankade kataloog vahemäluna.
- `exchange_rates`
  Keskpanga kursid vahemäluna.
- `settings`
  Vahemälu metaandmed (`lastSyncedAt`, kursi timestamp).

Kõik saldo muutused tehakse andmebaasi transaktsioonides.

## Toetatud endpointid

OpenAPI põhised endpointid:

- `POST /api/v1/users`
- `POST /api/v1/users/{userId}/accounts`
- `GET /api/v1/accounts/{accountNumber}`
- `POST /api/v1/transfers`
- `POST /api/v1/transfers/receive`
- `GET /api/v1/transfers/{transferId}`

Lisaks praktiliseks kasutuseks:

- `POST /api/v1/auth/tokens`
  Vahetab registreerimisel saadud API võtme Bearer JWT vastu.
- `GET /api/v1/users/{userId}`
- `GET /api/v1/users/{userId}/accounts`
- `GET /health`

## Bearer autentimine

1. Registreeri kasutaja `POST /api/v1/users` abil.
2. Loetud vastuse päisest `x-api-key` API võti.
3. Küsi Bearer tokenit:

```bash
curl -X POST http://localhost:8081/api/v1/auth/tokens \
  -H 'content-type: application/json' \
  -d '{"userId":"user-...","apiKey":"..."}'
```

4. Kasuta vastuses saadud `accessToken` väärtust `Authorization: Bearer ...` päises.

## Käivitamine

1. Paigalda sõltuvused:

```bash
npm install
```

2. Loo konfiguratsioon:

```bash
cp .env.example .env
```

3. Käivita API:

```bash
npm start
```

4. Käivita worker teises terminalis:

```bash
npm run start:worker
```

## Docker Compose

```bash
docker compose up --build
```

## Näidispäringud

Kasutaja registreerimine:

```bash
curl -i -X POST http://localhost:8081/api/v1/users \
  -H 'content-type: application/json' \
  -d '{"fullName":"Jane Doe","email":"jane@example.com"}'
```

Konto loomine:

```bash
curl -X POST http://localhost:8081/api/v1/users/$USER_ID/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"currency":"EUR"}'
```

Konto kontrollimine:

```bash
curl http://localhost:8081/api/v1/accounts/ESTABCDE
```

Ülekande algatamine:

```bash
curl -X POST http://localhost:8081/api/v1/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "transferId":"550e8400-e29b-41d4-a716-446655440000",
    "sourceAccount":"ESTAAAAA",
    "destinationAccount":"LATBBBBB",
    "amount":"25.00"
  }'
```

Ülekande staatuse küsimine:

```bash
curl http://localhost:8081/api/v1/transfers/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer $TOKEN"
```

## Keskpanga integratsioon

Worker kasutab järgmisi keskpanga endpoint'e:

- `POST /banks`
- `GET /banks`
- `POST /banks/{bankId}/heartbeat`
- `GET /exchange-rates`

Rahvusvahelistes ülekannetes allkirjastatakse JWT `ES256` algoritmiga ning vastuvõttev pank verifitseerib signatuuri keskpanga kataloogist saadud avaliku võtme abil.

## Ülekannete töötlus

- Pangasisene ülekanne: kohe transaktsioonis debiteerimine + krediteerimine.
- Pankadevaheline ülekanne:
  - lähtekontolt raha lukustatakse kohe,
  - sihtpanka üritatakse kohe kutsuda,
  - ajutise vea korral jääb staatus `pending`,
  - worker teeb exponential backoff retry,
  - 4 tunni järel märgitakse `failed_timeout` ja raha tagastatakse.

## Testimine

Automaatsete testide käivitamine:

```bash
npm test
```

Kaetud stsenaariumid:

- kasutaja registreerimine ja API võtme väljastus,
- Bearer tokeni loomine,
- pangasisene ülekanne,
- pankadevahelise JWT vastuvõtmine ja verifitseerimine.

## Live URL

https://tak25-branch-bank.onrender.com

Render Free tier, Node runtime. API ja worker jooksevad ühes protsessis.

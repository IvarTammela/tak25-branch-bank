import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { signInterbankToken } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { replaceBankDirectory, saveRegistration, setAccountBalance } from '../src/db.js';

const createConfig = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-bank-'));
  return {
    config: loadConfig({
      PORT: '0',
      DB_PATH: path.join(root, 'branch-bank.db'),
      KEY_DIR: path.join(root, 'keys'),
      BANK_NAME: 'TAK25 Test Bank',
      BANK_ADDRESS: 'http://localhost:8081',
      CENTRAL_BANK_BASE_URL: 'http://central-bank.invalid/api/v1',
      SUPPORTED_CURRENCIES: 'EUR,USD,GBP,SEK'
    }),
    root
  };
};

const registerUserAndToken = async (app: Awaited<ReturnType<typeof buildApp>>, fullName: string) => {
  const registerResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    payload: { fullName }
  });

  assert.equal(registerResponse.statusCode, 201);
  const registration = registerResponse.json();
  const apiKey = registerResponse.headers['x-api-key'];
  assert.ok(apiKey);

  const tokenResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/tokens',
    payload: {
      userId: registration.userId,
      apiKey
    }
  });

  assert.equal(tokenResponse.statusCode, 200);
  return {
    userId: registration.userId as string,
    token: tokenResponse.json().accessToken as string
  };
};

test('user registration exposes api key header and token flow', async () => {
  const { config, root } = await createConfig();
  const app = await buildApp(config);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { fullName: 'Jane Doe', email: 'jane@example.com' }
    });

    assert.equal(response.statusCode, 201);
    assert.ok(response.headers['x-api-key']);
    const payload = response.json();
    assert.match(payload.userId, /^user-/);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('same-bank transfer moves funds and updates balances', async () => {
  const { config, root } = await createConfig();
  const app = await buildApp(config);

  try {
    saveRegistration(app.state.db, 'EST001', new Date(Date.now() + 30 * 60 * 1000).toISOString(), new Date().toISOString());

    const alice = await registerUserAndToken(app, 'Alice Sender');
    const bob = await registerUserAndToken(app, 'Bob Receiver');

    const aliceAccountResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${alice.userId}/accounts`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { currency: 'EUR' }
    });
    const bobAccountResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${bob.userId}/accounts`,
      headers: { authorization: `Bearer ${bob.token}` },
      payload: { currency: 'EUR' }
    });

    assert.equal(aliceAccountResponse.statusCode, 201);
    assert.equal(bobAccountResponse.statusCode, 201);

    const aliceAccount = aliceAccountResponse.json().accountNumber as string;
    const bobAccount = bobAccountResponse.json().accountNumber as string;
    setAccountBalance(app.state.db, aliceAccount, 15000);

    const transferResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        transferId: '550e8400-e29b-41d4-a716-446655440000',
        sourceAccount: aliceAccount,
        destinationAccount: bobAccount,
        amount: '25.00'
      }
    });

    assert.equal(transferResponse.statusCode, 201);
    assert.equal(transferResponse.json().status, 'completed');

    const accountsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${bob.userId}/accounts`,
      headers: { authorization: `Bearer ${bob.token}` }
    });

    assert.equal(accountsResponse.statusCode, 200);
    assert.equal(accountsResponse.json().accounts[0].balance, '25.00');
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('inter-bank receive verifies es256 jwt and credits destination account', async () => {
  const { config, root } = await createConfig();
  const app = await buildApp(config);

  try {
    saveRegistration(app.state.db, 'LAT002', new Date(Date.now() + 30 * 60 * 1000).toISOString(), new Date().toISOString());
    replaceBankDirectory(app.state.db, {
      banks: [
        {
          bankId: 'EST001',
          name: 'Remote Bank',
          address: 'http://remote-bank:8081',
          publicKey: '',
          lastHeartbeat: new Date().toISOString(),
          status: 'active'
        }
      ],
      lastSyncedAt: new Date().toISOString()
    });

    const remoteKeys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' }
    });

    replaceBankDirectory(app.state.db, {
      banks: [
        {
          bankId: 'EST001',
          name: 'Remote Bank',
          address: 'http://remote-bank:8081',
          publicKey: remoteKeys.publicKey,
          lastHeartbeat: new Date().toISOString(),
          status: 'active'
        }
      ],
      lastSyncedAt: new Date().toISOString()
    });

    const user = await registerUserAndToken(app, 'Receiver User');
    const accountResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${user.userId}/accounts`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { currency: 'EUR' }
    });
    const destinationAccount = accountResponse.json().accountNumber as string;

    const jwt = await signInterbankToken(remoteKeys.privateKey, {
      transferId: '660e9511-f30c-52e5-b827-557766551111',
      sourceAccount: 'EST12345',
      destinationAccount,
      amount: '12.34',
      sourceAmount: '12.34',
      sourceBankId: 'EST001',
      destinationBankId: 'LAT002',
      sourceCurrency: 'EUR',
      destinationCurrency: 'EUR',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-1'
    });

    const receiveResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers/receive',
      payload: { jwt }
    });

    assert.equal(receiveResponse.statusCode, 200);
    assert.equal(receiveResponse.json().amount, '12.34');

    const accountsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${user.userId}/accounts`,
      headers: { authorization: `Bearer ${user.token}` }
    });

    assert.equal(accountsResponse.json().accounts[0].balance, '12.34');
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

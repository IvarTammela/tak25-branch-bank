import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export const ensureKeyPair = async (keyDir: string): Promise<KeyPair> => {
  const privateKeyPath = path.join(keyDir, 'bank-private.pem');
  const publicKeyPath = path.join(keyDir, 'bank-public.pem');

  await fs.mkdir(keyDir, { recursive: true });

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      fs.readFile(privateKeyPath, 'utf8'),
      fs.readFile(publicKeyPath, 'utf8')
    ]);

    return { privateKeyPem, publicKeyPem };
  } catch {
    const generated = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' }
    });

    await Promise.all([
      fs.writeFile(privateKeyPath, generated.privateKey, 'utf8'),
      fs.writeFile(publicKeyPath, generated.publicKey, 'utf8')
    ]);

    return {
      privateKeyPem: generated.privateKey,
      publicKeyPem: generated.publicKey
    };
  }
};

import { createHash, randomBytes } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';

import { AppError } from './errors.js';

const ACCESS_AUDIENCE = 'branch-bank-api';
const INTERBANK_AUDIENCE = 'branch-bank-transfer';

export interface InterbankClaims {
  transferId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  sourceBankId: string;
  destinationBankId: string;
  timestamp: string;
  nonce: string;
  sourceAmount?: string;
  sourceCurrency?: string;
  destinationCurrency?: string;
  exchangeRate?: string;
  rateCapturedAt?: string;
}

export const createApiKey = () => randomBytes(24).toString('base64url');

export const hashApiKey = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex');

export const issueAccessToken = async (
  privateKeyPem: string,
  issuer: string,
  userId: string,
  ttlSeconds: number
) => {
  const privateKey = await importPKCS8(privateKeyPem, 'ES256');

  return new SignJWT({ scope: 'user' })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(privateKey);
};

export const verifyAccessToken = async (publicKeyPem: string, issuer: string, token: string) => {
  try {
    const publicKey = await importSPKI(publicKeyPem, 'ES256');
    const result = await jwtVerify(token, publicKey, {
      issuer,
      audience: ACCESS_AUDIENCE
    });

    if (!result.payload.sub) {
      throw new AppError(401, 'UNAUTHORIZED', 'Token is missing a subject');
    }

    return result.payload.sub;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(401, 'UNAUTHORIZED', 'Invalid bearer token');
  }
};

export const signInterbankToken = async (privateKeyPem: string, claims: InterbankClaims) => {
  const privateKey = await importPKCS8(privateKeyPem, 'ES256');

  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer(claims.sourceBankId)
    .setAudience(INTERBANK_AUDIENCE)
    .setSubject(claims.transferId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
};

export const verifyInterbankToken = async (publicKeyPem: string, token: string) => {
  try {
    const publicKey = await importSPKI(publicKeyPem, 'ES256');

    let result;
    try {
      result = await jwtVerify(token, publicKey, { audience: INTERBANK_AUDIENCE });
    } catch {
      result = await jwtVerify(token, publicKey);
    }

    const payload = result.payload as unknown as InterbankClaims;
    if (!payload.transferId || !payload.sourceAccount || !payload.destinationAccount || !payload.amount) {
      throw new AppError(401, 'UNAUTHORIZED', 'Inter-bank token is missing required claims');
    }

    return payload;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    console.error('JWT verification failed:', (error as Error).message);
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid inter-bank JWT');
  }
};

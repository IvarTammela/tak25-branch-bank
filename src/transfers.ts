import { randomUUID } from 'node:crypto';

import type { AppConfig } from './config.js';
import { getBankDirectoryWithFallback, getExchangeRatesWithFallback } from './central-bank.js';
import {
  adjustAccountBalance,
  getAccountByNumber,
  getBankById,
  getBankByPrefix,
  getBanksByPrefix,
  getIdentity,
  listDuePendingTransfers,
  getTransferById,
  insertTransfer,
  markTransferCompleted,
  markTransferFailed,
  markTransferTimedOut,
  scheduleTransferRetry,
  type SqliteDatabase,
  type TransferRow
} from './db.js';
import { AppError } from './errors.js';
import { convertMoney, formatMoney, parseMoney } from './money.js';
import { signInterbankToken, verifyInterbankToken } from './auth.js';
import type { KeyPair } from './keys.js';

interface RemoteLookupResponse {
  accountNumber: string;
  ownerName: string;
  currency: string;
}

interface TransferRequestInput {
  transferId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
}

const ACCOUNT_PATTERN = /^[A-Z0-9]{8}$/;
const delayForRetryCount = (retryCount: number) => Math.min(60, 2 ** retryCount) * 60 * 1000;

const addDelay = (baseTimeIso: string, milliseconds: number) => new Date(new Date(baseTimeIso).getTime() + milliseconds).toISOString();

const isTimedOut = (pendingSince: string, nowIso: string) => new Date(nowIso).getTime() - new Date(pendingSince).getTime() >= 4 * 60 * 60 * 1000;

const normalizeBranchBankBase = (address: string) => {
  const normalized = address.replace(/\/+$/, '');
  return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`;
};

const fetchJson = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as T | { code?: string; message?: string }) : null;
  return { response, payload };
};

const ensureValidAccountNumber = (accountNumber: string, fieldName: string) => {
  if (!ACCOUNT_PATTERN.test(accountNumber)) {
    throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', `${fieldName} must be exactly 8 uppercase letters or digits`);
  }
};

const buildTransferResponse = (transfer: TransferRow) => ({
  transferId: transfer.transfer_id,
  status: transfer.status,
  sourceAccount: transfer.source_account,
  destinationAccount: transfer.destination_account,
  amount: formatMoney(transfer.amount_minor),
  convertedAmount: transfer.converted_amount_minor === null ? undefined : formatMoney(transfer.converted_amount_minor),
  exchangeRate: transfer.exchange_rate ?? undefined,
  rateCapturedAt: transfer.rate_captured_at ?? undefined,
  pendingSince: transfer.pending_since ?? undefined,
  nextRetryAt: transfer.next_retry_at ?? undefined,
  retryCount: transfer.status === 'pending' ? transfer.retry_count : undefined,
  timestamp: transfer.updated_at,
  errorMessage: transfer.error_message ?? undefined
});

const lookupRemoteAccount = async (bankAddress: string, accountNumber: string) => {
  let response: Response;
  let payload: RemoteLookupResponse | { code?: string; message?: string } | null;

  try {
    const baseUrl = normalizeBranchBankBase(bankAddress);
    ({ response, payload } = await fetchJson<RemoteLookupResponse>(`${baseUrl}/accounts/${accountNumber}`));
  } catch {
    throw new AppError(503, 'DESTINATION_BANK_UNAVAILABLE', 'Destination bank is temporarily unavailable. Transfer has been queued for retry.');
  }

  if (response.ok) {
    return payload as RemoteLookupResponse;
  }

  if (response.status === 404) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${accountNumber}' not found`);
  }

  throw new AppError(503, 'DESTINATION_BANK_UNAVAILABLE', 'Destination bank is temporarily unavailable. Transfer has been queued for retry.');
};

const assertTransferOwnership = (db: SqliteDatabase, transfer: TransferRow, userId: string) => {
  if (transfer.initiated_by_user_id === userId) {
    return;
  }

  const destination = getAccountByNumber(db, transfer.destination_account);
  if (destination?.owner_id === userId) {
    return;
  }

  throw new AppError(403, 'FORBIDDEN', 'You do not have access to this transfer');
};

const queueCrossBankTransfer = (
  db: SqliteDatabase,
  transfer: TransferRow,
  sourceAccountBalanceCheck: number
) => {
  const transaction = db.transaction(() => {
    const latestSource = getAccountByNumber(db, transfer.source_account);
    if (!latestSource) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${transfer.source_account}' not found`);
    }

    if (latestSource.balance_minor < sourceAccountBalanceCheck) {
      throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds in source account');
    }

    adjustAccountBalance(db, transfer.source_account, -transfer.locked_amount_minor);
    insertTransfer(db, transfer);
  });

  transaction();
};

const refundTransfer = (db: SqliteDatabase, transfer: TransferRow, status: 'failed' | 'failed_timeout', errorMessage: string, updatedAt: string) => {
  const transaction = db.transaction(() => {
    adjustAccountBalance(db, transfer.source_account, transfer.locked_amount_minor);
    if (status === 'failed_timeout') {
      markTransferTimedOut(db, transfer.transfer_id, updatedAt, errorMessage);
    } else {
      markTransferFailed(db, transfer.transfer_id, updatedAt, errorMessage);
    }
  });

  transaction();
};

const buildInterbankJwt = async (transfer: TransferRow, identity: ReturnType<typeof getIdentity>, keys: KeyPair) => {
  return signInterbankToken(keys.privateKeyPem, {
    transferId: transfer.transfer_id,
    sourceAccount: transfer.source_account,
    destinationAccount: transfer.destination_account,
    amount: formatMoney(transfer.converted_amount_minor ?? transfer.amount_minor),
    sourceAmount: formatMoney(transfer.amount_minor),
    sourceBankId: identity.bank_id ?? '',
    destinationBankId: transfer.destination_bank_id ?? '',
    sourceCurrency: transfer.source_currency ?? transfer.amount_currency,
    destinationCurrency: transfer.destination_currency ?? transfer.amount_currency,
    exchangeRate: transfer.exchange_rate ?? undefined,
    rateCapturedAt: transfer.rate_captured_at ?? undefined,
    timestamp: transfer.created_at,
    nonce: randomUUID()
  });
};

const attemptDelivery = async (
  db: SqliteDatabase,
  config: AppConfig,
  keys: KeyPair,
  transfer: TransferRow,
  options: { updateRetrySchedule: boolean }
) => {
  const identity = getIdentity(db);
  if (!identity.bank_id) {
    throw new AppError(503, 'BANK_NOT_REGISTERED', 'Bank registration with the central bank is not ready yet');
  }

  if (!transfer.destination_bank_id) {
    const updatedAt = new Date().toISOString();
    refundTransfer(db, transfer, 'failed', 'Transfer is missing destination bank ID', updatedAt);
    throw new AppError(500, 'INTERNAL_ERROR', 'Transfer is missing destination bank ID');
  }

  let resolvedBank = getBankById(db, transfer.destination_bank_id);
  if (!resolvedBank) {
    await getBankDirectoryWithFallback(db, config);
    resolvedBank = getBankById(db, transfer.destination_bank_id);
  }

  if (!resolvedBank) {
    const updatedAt = new Date().toISOString();
    refundTransfer(db, transfer, 'failed', `Destination bank for prefix '${transfer.destination_account.slice(0, 3)}' was not found`, updatedAt);
    throw new AppError(404, 'BANK_NOT_FOUND', `Destination bank for prefix '${transfer.destination_account.slice(0, 3)}' was not found`);
  }

  const jwt = await buildInterbankJwt(transfer, identity, keys);
  const targetUrl = `${normalizeBranchBankBase(resolvedBank.address)}/transfers/receive`;
  let response: Response;
  let payload: { transferId: string } | { code?: string; message?: string } | null;

  try {
    ({ response, payload } = await fetchJson<{ transferId: string }>(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jwt })
    }));
  } catch {
    if (options.updateRetrySchedule) {
      const updatedAt = new Date().toISOString();
      const retryCount = transfer.retry_count + 1;
      const nextRetryAt = addDelay(updatedAt, delayForRetryCount(retryCount));
      scheduleTransferRetry(db, transfer.transfer_id, updatedAt, nextRetryAt, retryCount);
    }

    throw new AppError(503, 'DESTINATION_BANK_UNAVAILABLE', 'Destination bank is temporarily unavailable. Transfer has been queued for retry.');
  }

  if (response.ok) {
    markTransferCompleted(db, transfer.transfer_id, new Date().toISOString());
    return getTransferById(db, transfer.transfer_id)!;
  }

  const errorBody = payload as { code?: string; message?: string } | null;
  const message = errorBody?.message ?? 'Destination bank rejected the transfer';

  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    refundTransfer(db, transfer, 'failed', message, new Date().toISOString());
    throw new AppError(response.status, errorBody?.code ?? 'TRANSFER_REJECTED', message);
  }

  if (options.updateRetrySchedule) {
    const updatedAt = new Date().toISOString();
    const retryCount = transfer.retry_count + 1;
    const nextRetryAt = addDelay(updatedAt, delayForRetryCount(retryCount));
    scheduleTransferRetry(db, transfer.transfer_id, updatedAt, nextRetryAt, retryCount);
  }

  throw new AppError(503, 'DESTINATION_BANK_UNAVAILABLE', 'Destination bank is temporarily unavailable. Transfer has been queued for retry.');
};

export const createTransfer = async (
  db: SqliteDatabase,
  config: AppConfig,
  keys: KeyPair,
  userId: string,
  input: TransferRequestInput
) => {
  ensureValidAccountNumber(input.sourceAccount, 'sourceAccount');
  ensureValidAccountNumber(input.destinationAccount, 'destinationAccount');

  if (input.sourceAccount === input.destinationAccount) {
    throw new AppError(400, 'INVALID_REQUEST', 'Source and destination accounts must be different');
  }

  const existing = getTransferById(db, input.transferId);
  if (existing) {
    if (existing.status === 'pending') {
      throw new AppError(409, 'TRANSFER_ALREADY_PENDING', `Transfer with ID '${input.transferId}' is already pending. Cannot submit duplicate transfer.`);
    }

    throw new AppError(409, 'DUPLICATE_TRANSFER', `A transfer with ID '${input.transferId}' already exists`);
  }

  const amountMinor = parseMoney(input.amount);
  const sourceAccount = getAccountByNumber(db, input.sourceAccount);
  if (!sourceAccount) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${input.sourceAccount}' not found`);
  }

  if (sourceAccount.owner_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You can only initiate transfers from your own accounts');
  }

  if (sourceAccount.balance_minor < amountMinor) {
    throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds in source account');
  }

  const identity = getIdentity(db);
  if (!identity.bank_prefix || !identity.bank_id) {
    throw new AppError(503, 'BANK_NOT_REGISTERED', 'Bank registration with the central bank is not ready yet');
  }

  if (!input.sourceAccount.startsWith(identity.bank_prefix)) {
    throw new AppError(400, 'INVALID_REQUEST', 'Source account must belong to this bank');
  }

  const now = new Date().toISOString();
  const localDestination = getAccountByNumber(db, input.destinationAccount);

  if (localDestination) {

    let resolvedConversion: { convertedMinor: number; exchangeRate: string; rateCapturedAt: string | null } = {
      convertedMinor: amountMinor,
      exchangeRate: '1.000000',
      rateCapturedAt: null
    };

    if (sourceAccount.currency !== localDestination.currency) {
      const snapshot = await getExchangeRatesWithFallback(db, config);
      const converted = convertMoney(amountMinor, sourceAccount.currency, localDestination.currency, snapshot);
      resolvedConversion = {
        ...converted,
        rateCapturedAt: snapshot.timestamp
      };
    }

    const transfer: TransferRow = {
      transfer_id: input.transferId,
      direction: 'outgoing',
      status: 'completed',
      source_account: sourceAccount.account_number,
      destination_account: localDestination.account_number,
      amount_minor: amountMinor,
      amount_currency: sourceAccount.currency,
      source_currency: sourceAccount.currency,
      destination_currency: localDestination.currency,
      converted_amount_minor: sourceAccount.currency === localDestination.currency ? null : resolvedConversion.convertedMinor,
      exchange_rate: sourceAccount.currency === localDestination.currency ? null : resolvedConversion.exchangeRate,
      rate_captured_at: sourceAccount.currency === localDestination.currency ? null : resolvedConversion.rateCapturedAt,
      error_message: null,
      initiated_by_user_id: userId,
      pending_since: null,
      next_retry_at: null,
      retry_count: 0,
      source_bank_id: identity.bank_id,
      destination_bank_id: identity.bank_id,
      created_at: now,
      updated_at: now,
      locked_amount_minor: amountMinor
    };

    const transaction = db.transaction(() => {
      const latestSource = getAccountByNumber(db, sourceAccount.account_number);
      const latestDestination = getAccountByNumber(db, localDestination.account_number);
      if (!latestSource || !latestDestination) {
        throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Transfer account is missing');
      }

      if (latestSource.balance_minor < amountMinor) {
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds in source account');
      }

      adjustAccountBalance(db, latestSource.account_number, -amountMinor);
      adjustAccountBalance(db, latestDestination.account_number, resolvedConversion.convertedMinor);
      insertTransfer(db, transfer);
    });

    transaction();
    return buildTransferResponse(getTransferById(db, input.transferId)!);
  }

  await getBankDirectoryWithFallback(db, config);

  const prefix = input.destinationAccount.slice(0, 3);
  const candidateBanks = getBanksByPrefix(db, prefix, identity.bank_id);
  if (candidateBanks.length === 0) {
    throw new AppError(404, 'BANK_NOT_FOUND', `Destination bank for prefix '${prefix}' was not found`);
  }

  let destinationBank: typeof candidateBanks[0] | undefined;
  let remoteAccount: RemoteLookupResponse | undefined;

  for (const candidate of candidateBanks) {
    try {
      remoteAccount = await lookupRemoteAccount(candidate.address, input.destinationAccount);
      destinationBank = candidate;
      break;
    } catch (error) {
      if (error instanceof AppError && error.code === 'ACCOUNT_NOT_FOUND') {
        continue;
      }
      if (error instanceof AppError && error.code === 'DESTINATION_BANK_UNAVAILABLE') {
        continue;
      }
      throw error;
    }
  }

  if (!destinationBank || !remoteAccount) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${input.destinationAccount}' not found on any remote bank`);
  }
  const snapshot = sourceAccount.currency === remoteAccount.currency
    ? null
    : await getExchangeRatesWithFallback(db, config);
  const conversion = snapshot
    ? convertMoney(amountMinor, sourceAccount.currency, remoteAccount.currency, snapshot)
    : { convertedMinor: amountMinor, exchangeRate: '1.000000' };

  const pendingTransfer: TransferRow = {
    transfer_id: input.transferId,
    direction: 'outgoing',
    status: 'pending',
    source_account: sourceAccount.account_number,
    destination_account: input.destinationAccount,
    amount_minor: amountMinor,
    amount_currency: sourceAccount.currency,
    source_currency: sourceAccount.currency,
    destination_currency: remoteAccount.currency,
    converted_amount_minor: sourceAccount.currency === remoteAccount.currency ? null : conversion.convertedMinor,
    exchange_rate: sourceAccount.currency === remoteAccount.currency ? null : conversion.exchangeRate,
    rate_captured_at: snapshot?.timestamp ?? null,
    error_message: null,
    initiated_by_user_id: userId,
    pending_since: now,
    next_retry_at: addDelay(now, 60_000),
    retry_count: 0,
    source_bank_id: identity.bank_id,
    destination_bank_id: destinationBank.bank_id,
    created_at: now,
    updated_at: now,
    locked_amount_minor: amountMinor
  };

  queueCrossBankTransfer(db, pendingTransfer, amountMinor);

  try {
    const delivered = await attemptDelivery(db, config, keys, pendingTransfer, { updateRetrySchedule: false });
    return buildTransferResponse(delivered);
  } catch (error) {
    if (error instanceof AppError && error.code === 'DESTINATION_BANK_UNAVAILABLE') {
      return buildTransferResponse(getTransferById(db, pendingTransfer.transfer_id)!);
    }

    throw error;
  }
};

export const getTransferStatus = (db: SqliteDatabase, transferId: string, userId: string) => {
  const transfer = getTransferById(db, transferId);
  if (!transfer) {
    throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer with ID '${transferId}' not found`);
  }

  assertTransferOwnership(db, transfer, userId);

  return buildTransferResponse(transfer);
};

export const receiveTransfer = async (db: SqliteDatabase, config: AppConfig, jwt: string) => {
  const [headerSegment, payloadSegment] = jwt.split('.');
  if (!headerSegment || !payloadSegment) {
    throw new AppError(401, 'UNAUTHORIZED', 'Malformed inter-bank token');
  }

  let payload: { sourceBankId?: string };
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as { sourceBankId?: string };
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Malformed inter-bank token');
  }

  const sourceBankId = payload.sourceBankId;
  if (!sourceBankId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Inter-bank token is missing sourceBankId');
  }

  await getBankDirectoryWithFallback(db, config);
  const sourceBank = getBankById(db, sourceBankId);
  if (!sourceBank) {
    throw new AppError(403, 'FORBIDDEN', `Source bank '${sourceBankId}' is not registered`);
  }

  const claims = await verifyInterbankToken(sourceBank.public_key, jwt);
  const identity = getIdentity(db);
  if (!identity.bank_id || claims.destinationBankId !== identity.bank_id) {
    throw new AppError(403, 'FORBIDDEN', 'Transfer is not intended for this bank');
  }

  ensureValidAccountNumber(claims.destinationAccount, 'destinationAccount');
  const destinationAccount = getAccountByNumber(db, claims.destinationAccount);
  if (!destinationAccount) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${claims.destinationAccount}' not found`);
  }

  const existing = getTransferById(db, claims.transferId);
  if (existing) {
    return {
      transferId: existing.transfer_id,
      status: existing.status,
      destinationAccount: existing.destination_account,
      amount: formatMoney(existing.amount_minor),
      timestamp: existing.updated_at
    };
  }

  const creditedAmountMinor = parseMoney(claims.amount);
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    adjustAccountBalance(db, destinationAccount.account_number, creditedAmountMinor);
    insertTransfer(db, {
      transfer_id: claims.transferId,
      direction: 'incoming',
      status: 'completed',
      source_account: claims.sourceAccount,
      destination_account: destinationAccount.account_number,
      amount_minor: creditedAmountMinor,
      amount_currency: destinationAccount.currency,
      source_currency: claims.sourceCurrency ?? null,
      destination_currency: claims.destinationCurrency ?? destinationAccount.currency,
      converted_amount_minor: null,
      exchange_rate: claims.exchangeRate ?? null,
      rate_captured_at: claims.rateCapturedAt ?? null,
      error_message: null,
      initiated_by_user_id: null,
      pending_since: null,
      next_retry_at: null,
      retry_count: 0,
      source_bank_id: claims.sourceBankId,
      destination_bank_id: claims.destinationBankId,
      created_at: now,
      updated_at: now,
      locked_amount_minor: 0
    });
  });

  transaction();

  return {
    transferId: claims.transferId,
    status: 'completed',
    destinationAccount: destinationAccount.account_number,
    amount: formatMoney(creditedAmountMinor),
    timestamp: now
  };
};

export const processPendingTransfers = async (db: SqliteDatabase, config: AppConfig, keys: KeyPair) => {
  const now = new Date().toISOString();
  const dueTransfers = listDuePendingTransfers(db, now);

  for (const transfer of dueTransfers) {
    if (transfer.pending_since && isTimedOut(transfer.pending_since, now)) {
      refundTransfer(db, transfer, 'failed_timeout', 'Transfer timed out after 4 hours. Funds refunded to source account.', now);
      continue;
    }

    try {
      await attemptDelivery(db, config, keys, transfer, { updateRetrySchedule: true });
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }
    }
  }
};

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(plain: string): Promise<string> {
  const saltHex = randomBytes(SALT_BYTES).toString('hex');
  const derived = (await scryptAsync(plain, saltHex, KEY_LENGTH)) as Buffer;
  return `scrypt$${saltHex}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) {
    return false;
  }

  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== 'scrypt' || !saltHex || !hashHex) {
    return false;
  }

  let expectedBuffer: Buffer;
  try {
    expectedBuffer = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  if (expectedBuffer.length !== KEY_LENGTH) {
    return false;
  }

  const derived = (await scryptAsync(plain, saltHex, KEY_LENGTH)) as Buffer;
  if (derived.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derived, expectedBuffer);
}

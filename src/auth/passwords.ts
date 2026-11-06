import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP'ın scrypt için önerdiği değerlerden biri. Değerler özetin içinde saklanır,
// ileride artırılırsa eski şifreler çalışmaya devam eder.
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 128 * 1024 * 1024;

export async function hashPassword(password: string) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, { ...COST, maxmem: MAX_MEMORY });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) {
    return false;
  }
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return timingSafeEqual(actual, expected);
}

// Olmayan e-postada da aynı süre harcanır: cevap süresinden hangi adresin kayıtlı olduğu anlaşılmasın.
let decoy: Promise<string> | undefined;
export function decoyHash() {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}

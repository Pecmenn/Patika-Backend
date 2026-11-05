import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { ApiError } from '../http.ts';

export type AppleKeys = JWTVerifyGetKey;

const APPLE_ISSUER = 'https://appleid.apple.com';

export function createAppleKeys(): AppleKeys {
  return createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));
}

// Telefonun gönderdiği belgenin gerçekten Apple'dan geldiğini, bizim uygulamamız için
// üretildiğini ve süresinin dolmadığını doğrular. Bunlardan biri tutmazsa giriş reddedilir.
export async function verifyAppleToken(token: string, keys: AppleKeys, audiences: string[]) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: APPLE_ISSUER,
      audience: audiences,
      algorithms: ['RS256'],
    });
    if (!payload.sub) {
      throw new ApiError(401, 'invalid_apple_token');
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Apple'a ulaşılamadıysa belge sahte sayılmaz, kullanıcı yeniden dener.
    if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
      throw new ApiError(503, 'apple_unavailable');
    }
    throw new ApiError(401, 'invalid_apple_token');
  }
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { userIdForToken } from '../auth/sessions.ts';
import type { Deps } from '../deps.ts';

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const UNAUTHORIZED = 4401;
const SERVER_ERROR = 1011;

const AuthMessage = z.object({ type: z.literal('auth'), token: z.string().min(1).max(200) });

// Yeni ihbar telefona anında ulaşsın diye açık tutulan bağlantı.
// Oturum anahtarı adreste değil ilk mesajda gider: adresler kayıt dosyalarına yazılır.
export function registerRealtimeRoutes(app: FastifyInstance, { db, hub }: Deps) {
  app.get('/v1/events', { websocket: true }, (socket) => {
    let userId: string | null = null;
    let isAlive = true;

    const authTimer = setTimeout(() => socket.close(UNAUTHORIZED, 'unauthorized'), AUTH_TIMEOUT_MS);
    // Kopan bağlantılar fark edilip kapatılsın.
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        socket.terminate();
        return;
      }
      isAlive = false;
      socket.ping();
    }, HEARTBEAT_MS);

    socket.on('pong', () => {
      isAlive = true;
    });

    socket.on('message', async (raw: Buffer) => {
      if (userId) {
        return;
      }
      clearTimeout(authTimer);
      let token: string;
      try {
        ({ token } = AuthMessage.parse(JSON.parse(raw.toString())));
      } catch {
        socket.close(UNAUTHORIZED, 'unauthorized');
        return;
      }
      try {
        const found = await userIdForToken(db, token);
        if (!found) {
          socket.close(UNAUTHORIZED, 'unauthorized');
          return;
        }
        // Kimlik denetimi sürerken bağlantı kapanmış olabilir.
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        userId = found;
        hub.add(found, socket, token);
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch (error) {
        // Geçici sunucu hatası oturumun geçersiz olduğu anlamına gelmez, telefon yeniden dener.
        app.log.error(error);
        socket.close(SERVER_ERROR, 'server_error');
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (userId) {
        hub.remove(userId, socket);
      }
    });
  });
}

import type { WebSocket } from 'ws';

export type Hub = ReturnType<typeof createHub>;

const SESSION_ENDED = 4401;

// Açık telefon bağlantılarını kullanıcıya göre tutar, her bağlantının hangi oturuma ait olduğunu bilir.
// Tek sunucu için yeterli. Birden çok sunucuya geçilirse ortak bir mesaj kanalı gerekir.
export function createHub() {
  const users = new Map<string, Map<WebSocket, string>>();

  function remove(userId: string, socket: WebSocket) {
    const own = users.get(userId);
    own?.delete(socket);
    if (own?.size === 0) {
      users.delete(userId);
    }
  }

  return {
    add(userId: string, socket: WebSocket, token: string) {
      const own = users.get(userId) ?? new Map<WebSocket, string>();
      own.set(socket, token);
      users.set(userId, own);
    },
    remove,
    publish(userId: string, event: object) {
      const message = JSON.stringify(event);
      for (const socket of users.get(userId)?.keys() ?? []) {
        socket.send(message);
      }
    },
    // Çıkış yapan telefon kapanır, aynı hesabın diğer telefonu çalışmaya devam eder.
    closeSession(userId: string, token: string) {
      for (const [socket, ownToken] of users.get(userId) ?? []) {
        if (ownToken === token) {
          socket.close(SESSION_ENDED, 'session_ended');
        }
      }
    },
    closeUser(userId: string) {
      for (const socket of users.get(userId)?.keys() ?? []) {
        socket.close(SESSION_ENDED, 'session_ended');
      }
    },
  };
}

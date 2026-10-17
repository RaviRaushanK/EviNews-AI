'use strict';

const HOST = 'generativelanguage.googleapis.com';
const CODES = new Set(['EACCES', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function probeGeminiEgress(authorization, dependencies = {}) {
  if (authorization !== 'AUTHORIZE_CREDENTIAL_FREE_CONNECTIVITY_PROBE') return Promise.resolve({ dns: false, tcp: false, tls: false, code: 'NOT_AUTHORIZED' });
  const lookup = dependencies.lookup || require('node:dns').lookup;
  const connect = dependencies.connect || require('node:net').connect;
  const secure = dependencies.secure || require('node:tls').connect;
  return new Promise(resolve => {
    let socket, tlsSocket, settled = false;
    const result = { dns: false, tcp: false, tls: false, code: null };
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      result.code = error ? (CODES.has(error.code) ? error.code : 'UNCLASSIFIED') : null;
      tlsSocket?.destroy(); socket?.destroy(); resolve(Object.freeze({ ...result }));
    };
    const timer = setTimeout(() => finish({ code: 'ETIMEDOUT' }), 10000);
    try {
      lookup(HOST, { family: 4, all: true }, (error, addresses) => {
        if (settled) return;
        if (error) { finish(error); return; }
        const valid = Array.isArray(addresses) && addresses.filter(row => row.family === 4 && typeof row.address === 'string' &&
          row.address.split('.').length === 4 && row.address.split('.').every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255));
        if (!valid?.length) { finish({ code: 'ENOTFOUND' }); return; }
        valid.sort((a, b) => {
          const aa = a.address.split('.').map(Number), bb = b.address.split('.').map(Number);
          for (let i = 0; i < 4; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]; return 0;
        });
        result.dns = true;
        try {
          socket = connect({ host: valid[0].address, port: 443, family: 4 });
          socket.once('error', finish);
          socket.once('connect', () => {
            if (settled) return;
            result.tcp = true;
            try {
              tlsSocket = secure({ socket, servername: HOST, rejectUnauthorized: true });
              tlsSocket.once('error', finish);
              tlsSocket.once('secureConnect', () => {
                if (!tlsSocket.authorized) { finish({ code: 'UNCLASSIFIED' }); return; }
                result.tls = true; finish();
              });
            } catch (failure) { finish(failure); }
          });
        } catch (failure) { finish(failure); }
      });
    } catch (failure) { finish(failure); }
  });
}
if (require.main === module) {
  const approved = process.argv.length === 3 && process.argv[2] === '--authorize-credential-free-probe';
  void probeGeminiEgress(approved ? 'AUTHORIZE_CREDENTIAL_FREE_CONNECTIVITY_PROBE' : null).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.tls ? 0 : 1;
  });
}
module.exports = { probeGeminiEgress };

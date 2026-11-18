const express = require('express');
const { join } = require('path');

function startServer(port, cb) {
  const app = express();
  app.use(express.static(join(__dirname, './resources')));

  let actualServer;
  let callbackCalled = false;

  const callCallback = (err) => {
    if (callbackCalled) {
      return;
    }
    callbackCalled = true;
    cb(err);
  };

  const tryListen = (p) => {
    const server = app.listen(p, () => {
      actualServer = server;
      const address = server.address();
      server.port = address ? address.port : p;
      global.__VT_TEST_PORT = server.port;
      callCallback();
    });
    server.on('error', (err) => {
      if (p !== 0 && (err.code === 'EACCES' || err.code === 'EADDRINUSE')) {
        tryListen(0);
      } else {
        callCallback(err);
      }
    });
  };

  tryListen(port);

  // 返回一个代理对象，确保调用方访问到实际监听的 server
  return {
    get port() {
      return actualServer ? actualServer.port : (global.__VT_TEST_PORT || port);
    },
    address() {
      return actualServer ? actualServer.address() : null;
    },
    close(cb) {
      if (actualServer) {
        return actualServer.close(cb);
      }
      if (cb) {
        cb();
      }
      return this;
    },
    on(event, handler) {
      if (actualServer) {
        actualServer.on(event, handler);
      }
      return this;
    }
  };
}

function getTestServerPort() {
  return global.__VT_TEST_PORT || 4398;
}

function replaceTestPort(value, port) {
  port = port || getTestServerPort();
  if (typeof value === 'string') {
    return value.replace(/localhost:4398/g, `localhost:${port}`);
  }
  return value;
}

function replaceTestPortDeep(obj, port) {
  port = port || getTestServerPort();
  if (typeof obj === 'string') {
    return obj.replace(/localhost:4398/g, `localhost:${port}`);
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = replaceTestPortDeep(obj[i], port);
    }
    return obj;
  }
  if (obj && typeof obj === 'object') {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        obj[key] = replaceTestPortDeep(obj[key], port);
      }
    }
    return obj;
  }
  return obj;
}

module.exports = startServer;
module.exports.getTestServerPort = getTestServerPort;
module.exports.replaceTestPort = replaceTestPort;
module.exports.replaceTestPortDeep = replaceTestPortDeep;

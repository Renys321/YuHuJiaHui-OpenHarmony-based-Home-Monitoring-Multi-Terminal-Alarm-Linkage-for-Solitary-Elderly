'use strict';

/*
 * Probe-only public-sync entry used by the lifecycle probe.
 * It never talks to a broker, backend, device or the network.
 */
let timer = null;

async function main() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {}, 1000);
  return {
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

function readHidden() {
  return Promise.resolve('PROBE_ONLY_KEY_NOT_A_SECRET');
}

module.exports = Object.freeze({ main, readHidden });

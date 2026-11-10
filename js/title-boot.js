// Lightweight page bootstrap, offline check and load-failure notice.
// 집(gosiwon.html)에서 막 나왔으면 시작 화면을 건너뛰고 하얀 화면에서 이어 간다
import Linker from './utils/Linker.js';

(function () {
  'use strict';

  try {
    var v = new Linker().read();
    var fresh = v && Date.now() - (Number(v.at) || 0) < 6 * 3600e3;
    if (v && v.v === 1 && v.dir === 'out' && fresh) document.documentElement.classList.add('linkout');
  } catch { }

  const MSG_OFFLINE = '인터넷에 연결되어 있지 않습니다. 연결을 확인해 주세요.';

  function showError(text) {
    const el = document.getElementById('err');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  window.addEventListener('load', () => {
    if (navigator.onLine) return;
    showError(MSG_OFFLINE);
  });

  window.addEventListener('offline', () => { showError(MSG_OFFLINE); });
  window.addEventListener('online', () => { location.reload(); });
})();
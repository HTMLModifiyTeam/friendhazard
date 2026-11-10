// Lightweight page bootstrap and load-failure notice.
// 밖(원래 게임)에서 들어왔으면 시작 화면 대신 어두운 현관 앞에서 시작
import { $ } from '../utils.js';
import Linker from '../utils/Linker.js';

(function () {
  'use strict';

  try {
    var v = new Linker().read();
    if (v && v.v === 1 && v.dir === 'in' && Date.now() - (Number(v.at) || 0) < 6 * 3600e3) {
      var title = $('title'), gate = $('gate'), fade = $('fade');
      if (title && gate && fade) {
        title.hidden = true;
        gate.hidden = false;
        fade.style.opacity = 1;
        fade.style.visibility = 'visible';
      }
    }
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
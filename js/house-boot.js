// Lightweight page bootstrap and load-failure notice.
// 밖(원래 게임)에서 들어왔으면 시작 화면 대신 어두운 현관 앞에서 시작
(function () {
  try {
    var v = JSON.parse(sessionStorage.getItem('fh_link') || 'null');
    if (!v) {
      var m = location.hash.match(/[#&]s=([^&]+)/);
      if (m) v = JSON.parse(decodeURIComponent(m[1]));
    }
    if (v && v.v === 1 && v.dir === 'in' && Date.now() - (v.at || 0) < 6 * 3600e3) {
      document.getElementById('title').hidden = true;
      document.getElementById('gate').hidden = false;
      var f = document.getElementById('fade');
      f.style.opacity = 1;
      f.style.visibility = 'visible';
    }
  } catch { }
})();
setTimeout(function () {
  if (!window.__fhReady) {
    var e = document.getElementById('err');
    e.hidden = false;
    e.textContent = '3D 화면을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';
  }
}, 15000);
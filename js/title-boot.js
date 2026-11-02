// Lightweight page bootstrap and load-failure notice.
// 집(gosiwon.html)에서 막 나왔으면 시작 화면을 건너뛰고 하얀 화면에서 이어 간다
(function () {
  try {
    var v = JSON.parse(sessionStorage.getItem('fh_link') || 'null');
    if (!v) {
      var m = location.hash.match(/[#&]s=([^&]+)/);
      if (m) v = JSON.parse(decodeURIComponent(m[1]));
    }
    if (v && v.v === 1 && v.dir === 'out' && Date.now() - (v.at || 0) < 6 * 3600e3) document.documentElement.classList.add('linkout');
  } catch (e) { }
})();
// 3D 라이브러리를 못 불러오면 안내
setTimeout(function () {
  if (!window.__fh) {
    var e = document.getElementById('err');
    e.textContent = '게임을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';
    e.hidden = false;
  }
}, 12000);
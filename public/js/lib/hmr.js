/* HMR — live-reload otomatis saat file public/ berubah. */
(function () {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/api/hmr');
  ws.addEventListener('message', function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.event === 'reload') location.reload();
    } catch (_) {}
  });
})();
